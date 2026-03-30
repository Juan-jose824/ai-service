require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const pdf     = require('pdf-parse');
const cors    = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

let analyzeManual = null;
let detectBusinessProcesses = null;
try { ({ analyzeManual } = require('./openclaw/client')); } catch(_) {}
try { ({ detectBusinessProcesses } = require('./services/processDetection')); } catch(_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: '150mb' }));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
            cb(null, true);
        } else {
            cb(new Error('Solo se aceptan archivos PDF.'));
        }
    },
});
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CONFIG = {
    model:       'gemini-2.5-flash',
    maxPdfChars: 280_000,
    maxTokens:   65_536,
    temperature: 0,
    timeout:     180_000,
};

function xmlEscape(str) {
    return (str || '')
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&apos;');
}

// ─────────────────────────────────────────────────────────────────────────────
// generateLogic
// ─────────────────────────────────────────────────────────────────────────────
function generateLogic(structure, processId, lanePrefix = '') {
    const { roles, steps } = structure;
    const pfx = lanePrefix === '' ? 'p0_' : `p${lanePrefix}_`;
    const pid  = id => `${pfx}${id}`;
    const fid  = (s, t) => `Flow_${pfx}${s}_${pfx}${t}`;

    const lanes = roles.map((role, idx) => {
        const laneId = `Lane_${lanePrefix}${idx}`;
        const refs = steps.filter(s => s.role === role)
            .map(s => `        <flowNodeRef>${pid(s.id)}</flowNodeRef>`).join('\n');
        return `      <lane id="${laneId}" name="${xmlEscape(role)}">\n${refs}\n      </lane>`;
    }).join('\n');

    const elements = steps.map(step => {
        const sid      = pid(step.id);
        const outgoing = (step.next || []).map(t => `      <outgoing>${fid(step.id, t)}</outgoing>`).join('\n');
        const incoming = steps.filter(s => (s.next || []).includes(step.id))
            .map(s => `      <incoming>${fid(s.id, step.id)}</incoming>`).join('\n');
        let xml = '';
        switch (step.type) {
            case 'startEvent':
                xml = `    <startEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </startEvent>`; break;

            case 'endEvent':
                xml = `    <endEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </endEvent>`; break;

            case 'endEventMessage':
                xml = `    <endEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n      <messageEventDefinition/>\n    </endEvent>`; break;

            case 'endEventTerminate':
                xml = `    <endEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n      <terminateEventDefinition/>\n    </endEvent>`; break;

            case 'endEventSignal':
                xml = `    <endEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n      <signalEventDefinition/>\n    </endEvent>`; break;

            case 'exclusiveGateway':
                xml = `    <exclusiveGateway id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </exclusiveGateway>`; break;
            case 'userTask':
                xml = `    <userTask id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </userTask>`; break;
            case 'serviceTask':
                xml = `    <serviceTask id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </serviceTask>`; break;
            case 'scriptTask':
                xml = `    <scriptTask id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </scriptTask>`; break;

            case 'intermediateEvent':
                // ✅ FIX: <linkEventDefinition/> evita el error "Simple no soportado" en Bizagi
                xml = `    <intermediateCatchEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </intermediateCatchEvent>`; break;

            case 'intermediateEventMessage':
                xml = `    <intermediateThrowEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n      <messageEventDefinition/>\n    </intermediateThrowEvent>`; break;

            // ✅ FIX 1: intermediateEventMultiple ahora se renderiza como serviceTask
            // Antes era intermediateCatchEvent con linkEventDefinition, lo que generaba
            // un círculo pequeño. Como el menú principal es 1 solo nodo que distribuye
            // a varios módulos, se recomienda modelarlo como tarea de servicio.
            case 'intermediateEventMultiple':
                xml = `    <serviceTask id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </serviceTask>`; break;

            default:
                xml = `    <task id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </task>`;
        }
        return xml;
    }).join('\n');

    const sequences = steps.flatMap(step =>
        (step.next || []).map(targetId => {
            const condAttr = step.conditions?.[targetId] ? ` name="${xmlEscape(step.conditions[targetId])}"` : '';
            return `    <sequenceFlow id="${fid(step.id, targetId)}" sourceRef="${pid(step.id)}" targetRef="${pid(targetId)}"${condAttr}/>`;
        })
    ).join('\n');

    return `  <process id="${processId}" isExecutable="false">
    <laneSet id="LaneSet_1">
${lanes}
    </laneSet>
${elements}
${sequences}
  </process>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateDI — layout profesional
// ─────────────────────────────────────────────────────────────────────────────
function generateDI(structure, processId, poolOpts = {}) {
    const { roles, steps } = structure;
    const POOL_ID   = poolOpts.poolId    ?? 'Participant_1';
    const POOL_Y    = poolOpts.poolY     ?? 60;
    const LANE_PFX  = poolOpts.lanePrefix ?? '';
    const NODE_PFX  = LANE_PFX === '' ? 'p0_' : `p${LANE_PFX}_`;
    const npid      = id => `${NODE_PFX}${id}`;
    const nfid      = (s, t) => `Flow_${NODE_PFX}${s}_${NODE_PFX}${t}`;

    const NODE_W = { startEvent:24, endEvent:24, endEventMessage:24,
                     intermediateEvent:24, intermediateEventMessage:24,
                     exclusiveGateway:32, parallelGateway:32,
                     userTask:70, serviceTask:70, scriptTask:70, task:70 };
    const NODE_H = { startEvent:24, endEvent:24, endEventMessage:24,
                     intermediateEvent:24, intermediateEventMessage:24,
                     exclusiveGateway:32, parallelGateway:32,
                     userTask:45, serviceTask:45, scriptTask:45, task:45 };
    const nw = t => NODE_W[t] ?? 90;
    const nh = t => NODE_H[t] ?? 60;

    const isSmall  = t => NODE_W[t] === 30 || NODE_W[t] === 40;
    const isCircle = t => ['startEvent','endEvent','endEventMessage',
                           'intermediateEvent','intermediateEventMessage'].includes(t);
    const isGW     = t => t?.includes('Gateway');
    const isTask   = t => !isCircle(t) && !isGW(t);

    const GAP_CC  = 60;
    const GAP_CT  = 65;
    const GAP_CG  = 55;
    const GAP_TC  = 65;
    const GAP_TT  = 90;
    const GAP_TG  = 60;
    const GAP_GT  = 85;
    const GAP_GC  = 60;
    const GAP_GG  = 65;

    function getGap(srcType, tgtType) {
        const sc = isCircle(srcType), sg = isGW(srcType);
        const tc = isCircle(tgtType), tg = isGW(tgtType);
        if (sc && tc) return GAP_CC;
        if (sc && tg) return GAP_CG;
        if (sc)       return GAP_CT;
        if (sg && tc) return GAP_GC;
        if (sg && tg) return GAP_GG;
        if (sg)       return GAP_GT;
        if (tc)       return GAP_TC;
        if (tg)       return GAP_TG;
        return GAP_TT;
    }

    const POOL_LABEL_W = 30;
    const LANE_LABEL_W = 50;
    const POOL_X       = 160;
    const LANE_X       = POOL_X + LANE_LABEL_W;

    const LANE_PAD_LEFT  = 75;
    const LANE_PAD_TOP   = 75;
    const LANE_PAD_BOT   = 55;
    const LANE_MIN_H     = 160;
    const ROW_GAP = 105;

    const stepMap = {};
    steps.forEach(s => { stepMap[s.id] = s; });

    // ── PASO 1: Asignar columnas (BFS por lane) ──────────────────────────────
    // ✅ FIX 2: Se incluyen también las aristas cross-lane al calcular inDeg.
    // Esto evita que nodos que reciben de otro lane tengan inDeg=0 dentro del lane
    // y compitan con el bridge (EvtBr_) por la columna 0, causando superposición.
    const nodeCol = {};
    steps.forEach(s => { nodeCol[s.id] = 0; });

    roles.forEach(role => {
        const ls = steps.filter(s => s.role === role);
        if (!ls.length) return;
        const laneIds = new Set(ls.map(s => s.id));

        // Detectar back-edges con DFS
        const backEdges = new Set();
        const mark = {};
        const dfs = id => {
            if (mark[id] === 2) return;
            mark[id] = 1;
            (stepMap[id]?.next || []).forEach(nid => {
                if (!laneIds.has(nid)) return;
                if (mark[nid] === 1) backEdges.add(`${id}->${nid}`);
                else if (!mark[nid]) dfs(nid);
            });
            mark[id] = 2;
        };
        ls.forEach(s => { if (!mark[s.id]) dfs(s.id); });

        // BFS para asignar columnas
        const inDeg = {};
        ls.forEach(s => { inDeg[s.id] = 0; });

        // Aristas intra-lane
        ls.forEach(s => {
            (s.next || []).forEach(nid => {
                if (laneIds.has(nid) && !backEdges.has(`${s.id}->${nid}`))
                    inDeg[nid] = (inDeg[nid] || 0) + 1;
            });
        });

        // ✅ FIX 2: Aristas cross-lane (entrantes desde otros lanes)
        // Un nodo que recibe una arista de otro lane ya tiene "algo antes",
        // por lo que su inDeg debe ser >= 1 para no quedar en col=0 junto al bridge.
        steps.forEach(s => {
            if (laneIds.has(s.id)) return; // solo nodos externos al lane
            (s.next || []).forEach(nid => {
                if (laneIds.has(nid))
                    inDeg[nid] = (inDeg[nid] || 0) + 1;
            });
        });

        const queue = ls.filter(s => inDeg[s.id] === 0).map(s => s.id);
        if (!queue.length) queue.push(ls[0].id);
        const visited = new Set();
        while (queue.length) {
            const id = queue.shift();
            if (visited.has(id)) continue;
            visited.add(id);
            (stepMap[id]?.next || []).forEach(nid => {
                if (!laneIds.has(nid) || backEdges.has(`${id}->${nid}`)) return;
                const nc = (nodeCol[id] || 0) + 1;
                if (nc > (nodeCol[nid] || 0)) nodeCol[nid] = nc;
                if (!visited.has(nid)) queue.push(nid);
            });
        }
        const maxC = Math.max(0, ...ls.map(s => nodeCol[s.id] || 0));
        ls.forEach(s => { if (!visited.has(s.id)) nodeCol[s.id] = maxC + 1; });
    });

    // ── PASO 2: Asignar filas ─────────────────────────────────────────────────
    const nodeRow = {};
    steps.forEach(s => { nodeRow[s.id] = 0; });

    roles.forEach(role => {
        const ls = steps.filter(s => s.role === role);
        const laneIds = new Set(ls.map(s => s.id));
        const sorted = [...ls].sort((a, b) => (nodeCol[a.id] || 0) - (nodeCol[b.id] || 0));
        sorted.forEach(step => {
            if (!isGW(step.type)) return;
            const outs = (step.next || []).filter(nid => laneIds.has(nid));
            if (outs.length < 2) return;
            const gwRow = nodeRow[step.id] || 0;
            const propagate = (startId, row) => {
                const q = [startId]; const vis = new Set();
                while (q.length) {
                    const cid = q.shift();
                    if (vis.has(cid) || !laneIds.has(cid)) continue;
                    vis.add(cid);
                    if ((nodeRow[cid] || 0) < row) nodeRow[cid] = row;
                    (stepMap[cid]?.next || []).filter(n => laneIds.has(n) && !vis.has(n)).forEach(n => q.push(n));
                }
            };
            outs.forEach((nid, i) => propagate(nid, gwRow + i));
        });
    });

    // ── PASO 3: Posición CX por columna por lane ──────────────────────────────
    const colCX = {};
    roles.forEach(role => {
        const ls = steps.filter(s => s.role === role);
        if (!ls.length) return;
        const maxCol = Math.max(0, ...ls.map(s => nodeCol[s.id] || 0));

        const colType = {};
        ls.forEach(s => {
            const col = nodeCol[s.id] || 0;
            if (!colType[col] || nw(s.type) > nw(colType[col])) colType[col] = s.type;
        });

        let cx = LANE_X + LANE_PAD_LEFT;
        colCX[`${role}__0`] = cx;

        for (let col = 0; col < maxCol; col++) {
            const st = colType[col]  || 'userTask';
            const dt = colType[col+1] || 'userTask';
            const step = Math.round(nw(st)/2 + getGap(st, dt) + nw(dt)/2);
            cx += step;
            colCX[`${role}__${col+1}`] = cx;
        }
    });

    // ── PASO 4: Alturas de lane y posición Y ──────────────────────────────────
    const laneRowCount = {};
    roles.forEach(role => {
        const ls = steps.filter(s => s.role === role);
        laneRowCount[role] = ls.length ? Math.max(1, ...ls.map(s => (nodeRow[s.id] || 0) + 1)) : 1;
    });

    const laneH = {}, laneY = {};
    let curY = POOL_Y;
    roles.forEach((role, ri) => {
        const rows = laneRowCount[role] || 1;
        const h = LANE_PAD_TOP + (rows - 1) * ROW_GAP + 45 + LANE_PAD_BOT;
        laneH[ri]   = Math.max(LANE_MIN_H, h);
        laneY[ri]   = curY;
        curY += laneH[ri];
    });
    const poolH = curY - POOL_Y;

    // ── PASO 5: Posición pixel de cada nodo ───────────────────────────────────
    const pos = {};
    steps.forEach(s => {
        const w = nw(s.type), h = nh(s.type);
        const ri  = roles.indexOf(s.role);
        if (ri < 0) return;
        const col = nodeCol[s.id] ?? 0;
        const row = nodeRow[s.id] ?? 0;
        const cx  = colCX[`${s.role}__${col}`] ?? (LANE_X + LANE_PAD_LEFT + col * 230);
        const cy  = laneY[ri] + LANE_PAD_TOP + row * ROW_GAP;
        pos[s.id] = {
            x: Math.round(cx - w/2), y: Math.round(cy - h/2),
            w, h, cx: Math.round(cx), cy: Math.round(cy),
        };
    });

    // ── Ancho del pool ────────────────────────────────────────────────────────
    const maxRight = steps.reduce((m, s) => {
        const p = pos[s.id]; return p ? Math.max(m, p.x + p.w) : m;
    }, LANE_X + 500);
    const poolW = Math.max(900, maxRight + 140);

    // ── Helpers de geometría ──────────────────────────────────────────────────
    const P   = id => pos[id];
    const CX  = id => pos[id]?.cx ?? 0;
    const CY  = id => pos[id]?.cy ?? 0;
    const L   = id => pos[id]?.x  ?? 0;
    const R   = id => (pos[id]?.x ?? 0) + (pos[id]?.w ?? 0);
    const T   = id => pos[id]?.y  ?? 0;
    const BOT = id => (pos[id]?.y ?? 0) + (pos[id]?.h ?? 0);
    const wpt = pts => pts
        .map(([x, y]) => `        <di:waypoint x="${Math.round(x)}" y="${Math.round(y)}"/>`)
        .join('\n');

    // ── SHAPES ────────────────────────────────────────────────────────────────
    let shapes = `      <bpmndi:BPMNShape id="${POOL_ID}_di" bpmnElement="${POOL_ID}" isHorizontal="true">
        <dc:Bounds x="${POOL_X}" y="${POOL_Y}" width="${poolW}" height="${poolH}"/>
      </bpmndi:BPMNShape>\n`;

    roles.forEach((_, i) => {
        shapes += `      <bpmndi:BPMNShape id="Lane_${LANE_PFX}${i}_di" bpmnElement="Lane_${LANE_PFX}${i}" isHorizontal="true">
        <dc:Bounds x="${LANE_X}" y="${laneY[i]}" width="${poolW - LANE_LABEL_W}" height="${laneH[i]}"/>
      </bpmndi:BPMNShape>\n`;
    });

    steps.forEach(s => {
        const p = P(s.id);
        if (!p) return;
        shapes += `      <bpmndi:BPMNShape id="Shape_${npid(s.id)}" bpmnElement="${npid(s.id)}">
        <dc:Bounds x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>
      </bpmndi:BPMNShape>\n`;
    });

    // ── EDGES — routing profesional ───────────────────────────────────────────
    let edges = '';

    steps.forEach(step => {
        if (!P(step.id)) return;
        const srcRi  = roles.indexOf(step.role);
        const srcRow = nodeRow[step.id] ?? 0;
        const srcCol = nodeCol[step.id] ?? 0;

        (step.next || []).forEach((targetId, outIdx) => {
            if (!P(targetId)) return;
            const tgt    = stepMap[targetId];
            if (!tgt) return;
            const tgtRi  = roles.indexOf(tgt.role);
            const tgtRow = nodeRow[targetId] ?? 0;
            const tgtCol = nodeCol[targetId] ?? 0;

            const edgeId   = `Edge_${npid(step.id)}_${npid(targetId)}`;
            const flowId   = nfid(step.id, targetId);
            const condText = step.conditions?.[targetId];

            let pts = [];

            if (srcRi === tgtRi) {
                if (srcRow === tgtRow) {
                    if (CX(targetId) >= CX(step.id)) {
                        pts = [
                            [R(step.id),  CY(step.id)],
                            [L(targetId), CY(targetId)],
                        ];
                    } else {
                        const arcY = laneY[srcRi] + 15;
                        pts = [
                            [R(step.id),       CY(step.id)],
                            [R(step.id) + 15,  CY(step.id)],
                            [R(step.id) + 15,  arcY],
                            [L(targetId) - 15, arcY],
                            [L(targetId) - 15, CY(targetId)],
                            [L(targetId),      CY(targetId)],
                        ];
                    }
                } else {
                    const xPad = R(step.id) + 20 + outIdx * 16;
                    pts = [
                        [R(step.id),  CY(step.id)],
                        [xPad,        CY(step.id)],
                        [xPad,        CY(targetId)],
                        [L(targetId), CY(targetId)],
                    ];
                }
            } else {
                const goingDown = tgtRi > srcRi;
                const deltaX = Math.abs(CX(step.id) - CX(targetId));

                if (deltaX < 12) {
                    if (goingDown) {
                        pts = [
                            [CX(step.id), BOT(step.id)],
                            [CX(targetId), T(targetId)],
                        ];
                    } else {
                        pts = [
                            [CX(step.id), T(step.id)],
                            [CX(targetId), BOT(targetId)],
                        ];
                    }
                } else if (goingDown) {
                    const midGapY = Math.round((laneY[srcRi] + laneH[srcRi] + laneY[tgtRi]) / 2);
                    const srcCX   = CX(step.id);
                    const tgtCX   = CX(targetId);

                    if (Math.abs(srcCX - tgtCX) < 25) {
                        pts = [
                            [srcCX, BOT(step.id)],
                            [srcCX, T(targetId)],
                        ];
                    } else if (tgtCX < srcCX - 30) {
                        pts = [
                            [srcCX, BOT(step.id)],
                            [srcCX, midGapY],
                            [tgtCX, midGapY],
                            [tgtCX, T(targetId)],
                        ];
                    } else {
                        pts = [
                            [srcCX, BOT(step.id)],
                            [srcCX, midGapY],
                            [tgtCX, midGapY],
                            [tgtCX, T(targetId)],
                        ];
                    }
                } else {
                    const midGapY = Math.round((laneY[tgtRi] + laneH[tgtRi] + laneY[srcRi]) / 2);
                    const srcCX   = CX(step.id);
                    const tgtCX   = CX(targetId);

                    pts = [
                        [srcCX, T(step.id)],
                        [srcCX, midGapY],
                        [tgtCX, midGapY],
                        [tgtCX, BOT(targetId)],
                    ];
                }
            }

            let labelXml = '';
            if (condText) {
                const labelW = Math.min(condText.length * 7 + 12, 100);
                const lx = Math.round(pts[0][0] + 5);
                const ly = Math.round(pts[0][1] - 24);
                labelXml = `\n        <bpmndi:BPMNLabel><dc:Bounds x="${lx}" y="${ly}" width="${labelW}" height="20"/></bpmndi:BPMNLabel>`;
            }

            edges += `      <bpmndi:BPMNEdge id="${edgeId}" bpmnElement="${flowId}">${labelXml}
${wpt(pts)}
      </bpmndi:BPMNEdge>\n`;
        });
    });

    return { poolH, shapesXml: shapes, edgesXml: edges };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildPrompt
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(text) {
    return `Eres un analista de procesos BPMN experto. Tu objetivo es generar diagramas claros, concisos y profesionales — listos para ser presentados a un director de área sin explicación adicional.

═══════════════════════════════════════════════════════════
PASO PREVIO OBLIGATORIO — ANTES DE ESCRIBIR CUALQUIER COSA
═══════════════════════════════════════════════════════════
Antes de escribir el [MD_START] o el [JSON_START], haz lo siguiente:

1. Lee el manual COMPLETO de principio a fin, sin saltarte ninguna sección.
2. Enumera mentalmente TODOS los módulos, secciones y actores encontrados.
3. Verifica que cada módulo esté representado como mínimo por un lane en el JSON.
4. Presta especial atención a los módulos del FINAL del manual — son igual de
   importantes que los del inicio y no deben omitirse ni fusionarse por comodidad.
5. Solo cuando tengas el inventario completo, comienza a escribir la respuesta.

═══════════════════════════════════════════════════════════
FILOSOFÍA: MENOS ES MÁS
═══════════════════════════════════════════════════════════
El diagrama debe comunicar el PROPÓSITO de cada sección, no documentar cada clic de la interfaz.
Un director debe leerlo y entender el flujo en 30 segundos.

ANTES DE ESCRIBIR CADA TAREA, hazte esta pregunta:
  "¿Qué LOGRA el usuario en este paso?" → eso es el nombre de la tarea.
  "¿Cómo hace clic en la pantalla?" → eso NO va en el diagrama.

═══════════════════════════════════════════════════════════
REGLA 1 — NOMBRES DE TAREAS: CONCISOS Y DESCRIPTIVOS
═══════════════════════════════════════════════════════════
Máximo 4 palabras por nombre. Corto pero que se entienda el objetivo.

  ❌ "Ingresar nombre de usuario y contraseña para autenticarse"
  ✅ "Ingresar credenciales"

  ❌ "Seleccionar la opción Quiero crear mi cuenta nueva"
  ✅ "Crear cuenta nueva"

  ❌ "Presionar el botón Continuar para avanzar al siguiente paso"
  ✅ "Confirmar datos"

  ❌ "Dar clic en el ícono de editar para modificar el registro"
  ✅ "Editar registro"

  ❌ "Visualizar las opciones disponibles en el menú principal"
  ✅ "Acceso a menú principal"

Verbos preferidos: Ingresar · Validar · Confirmar · Seleccionar · Crear · Editar · Buscar · Registrar · Cerrar · Acceder · Generar · Enviar

PROHIBIDO: Presionar · Pulsar · Tocar · Dar clic · Hacer clic · Botón · Ícono

ANTI-PATRÓN — Secuencias técnicas repetitivas (muy común en sistemas con envío a SAJ o similar):
  El manual describe: "guardar borrador", "enviar al sistema", "reintentar si falla", "recibir confirmación", "ver número de inventario"
  Estos 5 pasos siempre ocurren igual en todos los módulos → consolidar en 2 tareas máximo:
    "Registrar solicitud" + Gateway(¿Exitoso?) → "Recibir confirmación" / "Reintentar envío"
  No repetir esta secuencia idéntica en cada módulo del manual.

═══════════════════════════════════════════════════════════
REGLA 2 — POOLS Y LANES (OBLIGATORIA)
═══════════════════════════════════════════════════════════
UN POOL = un actor, sistema o proceso diferenciado en el manual.
El campo "pools" del JSON define cuántos diagramas se generarán — uno por pool.

CUÁNDO crear múltiples pools:
  • El manual describe N actores distintos (ciudadano, técnico, admin, brigadista…)
  • El manual tiene secciones claramente independientes (Alta, Baja, Modificación…)
  • El manual tiene capítulos que son procesos separados aunque usen el mismo sistema
  → Un pool por cada actor o proceso independiente. Sin límite — puede ser 1, 2, 3, 4 o más.

  REGLA CLAVE — pool vs lane:
  Un POOL nuevo solo se justifica cuando hay un LOGIN DIFERENTE o un USUARIO DIFERENTE.
  Si varios módulos comparten el mismo login/menú → son LANES del mismo pool, no pools distintos.

  Ejemplo CORRECTO para manual SICSSE (Altas + Bajas, mismo sistema, mismo login):
    Pool 1 "SICSSE - Altas": login + Alta Compras Mayores + Alta Compras Menores + ... + logout
    Pool 2 "SICSSE - Bajas": login + Baja por Desuso + Baja por Siniestro + logout
    → 2 pools porque Altas y Bajas son procesos claramente separados en el manual.

  Ejemplo INCORRECTO (sobre-fragmentación):
    Pool 1 "Alta Compras Mayores" (con su propio login)
    Pool 2 "Alta Compras Menores" (con su propio login)  ← INCORRECTO: mismo login
    → Estos son LANES de un mismo pool "SICSSE - Altas", no pools distintos.

CUÁNDO crear un solo pool:
  • Solo hay un actor usando el sistema
  • Todas las secciones son módulos del mismo menú del mismo usuario

NOMBRE DEL POOL: nombre real del sistema, rol o proceso. Ejemplos:
  "Portal Ciudadano" · "Herramienta Brigadista" · "Bienes Técnicos - Altas" · "Bienes Técnicos - Bajas"
  PROHIBIDO: "Proceso de Negocio", "Pool 1", "Pool A", nombres genéricos.

ESTRUCTURA DE LANES dentro de cada pool:
  1. Primer lane: startEvent + login + menú principal
  2. [Un lane por cada módulo/sección, con el nombre exacto del módulo]
  3. Último lane: cierre de sesión

LANE DE INICIO DE SESIÓN — ESTRUCTURA FIJA (OBLIGATORIA):
  El lane de inicio de sesión tiene EXACTAMENTE estos 7 nodos, ni uno más ni uno menos:

    startEvent("Inicio de sesión")
    → userTask("Ingresar credenciales")
    → scriptTask("Validar acceso")
    → exclusiveGateway("¿Acceso correcto?")
        → [No]  endEvent("Acceso fallido")
        → [Sí]  userTask("Acceso a ventana principal")
                → intermediateEventMultiple("Menú principal")  ← hub que distribuye a todos los módulos

  ❌ PROHIBIDO en el lane de inicio de sesión:
     • Añadir recuperación de contraseña aquí — tiene su propio lane separado
     • Añadir validación de sesión previa, captcha, 2FA u otros pasos extra
     • Añadir más de 1 gateway
     • Superar los 7 nodos bajo ninguna circunstancia
     • Poner el intermediateEventMultiple antes del userTask "Acceso a ventana principal"

  El intermediateEventMultiple es el ÚNICO punto de salida hacia todos los módulos.
  Sus "next" deben incluir el intermediateEvent de entrada de CADA lane de módulo,
  más el intermediateEvent del lane de cierre de sesión.

⚠️ NOMBRES DE LANES — REGLA CRÍTICA:
  Cada lane en todo el JSON debe tener un nombre ÚNICO en todo el documento.
  Si dos pools tienen un lane de login, NO pueden llamarse igual.
  Usa el nombre del actor como sufijo: "Inicio de sesión Ciudadano", "Inicio de sesión Brigadista"
  Lo mismo para "Cerrar sesión": "Cerrar sesión Ciudadano", "Cerrar sesión Brigadista"

  ❌ PROHIBIDO (nombres duplicados entre pools):
     Pool 1: ["Inicio de sesión", "Módulo A", "Cerrar sesión"]
     Pool 2: ["Inicio de sesión", "Módulo B", "Cerrar sesión"]  ← INCORRECTO

  ✅ CORRECTO (nombres únicos):
     Pool 1: ["Inicio de sesión Ciudadano", "Módulo A", "Cerrar sesión Ciudadano"]
     Pool 2: ["Inicio de sesión Brigadista", "Módulo B", "Cerrar sesión Brigadista"]

LANE DE CIERRE — reglas especiales:
  • Máximo 2-3 nodos: un intermediateEvent de entrada + 1 tarea + endEvent
  • NUNCA un startEvent en el lane de cierre — siempre recibe desde el menú
  • Ejemplo: Evt_CerrarSesion → Task_ConfirmarCierre → End_Sesion

Cada pool tiene su propio startEvent. NUNCA conectar nodos entre pools distintos.

SUB-FASES DE MÓDULOS:
  Cuando un módulo describe etapas claramente diferenciadas en el manual
  (Registro, Seguimiento, Documentos, Aprobación, Envío SAJ…), cada etapa
  con pasos propios merece su propio lane.
  Si la etapa tiene solo 1-2 pasos genéricos, consérvala unida al lane principal.

═══════════════════════════════════════════════════════════
REGLA 3 — CANTIDAD DE NODOS POR LANE (LÍMITE ESTRICTO)
═══════════════════════════════════════════════════════════
MÁXIMO ABSOLUTO: 7 nodos por lane. Este límite es INVIOLABLE.
Objetivo ideal: entre 3 y 5 nodos por lane.

ANTES de escribir el JSON, cuenta los nodos de cada lane mentalmente.
Si llegas a 7 y aún tienes pasos pendientes → PARA y divide en Parte 1 / Parte 2.

CÓMO RESPETAR EL LÍMITE — consolidar pasos relacionados en una sola tarea:

  Patrón FORMULARIO (muy común en sistemas):
    Manual: "ingresar nombre", "ingresar CURP", "ingresar correo", "ingresar teléfono"
    Diagrama: UNA tarea "Completar formulario" o "Ingresar datos"
    NUNCA una tarea por cada campo del formulario.

  Patrón VALIDACIÓN:
    Manual: "el sistema valida formato, verifica en BD, comprueba duplicados, muestra resultado"
    Diagrama: UNA tarea "Validar datos"

  Patrón DESCARGA/GENERACIÓN:
    Manual: "el sistema genera el archivo", "muestra vista previa", "el usuario descarga"
    Diagrama: UNA tarea "Generar y descargar documento"

  Patrón CONFIRMACIÓN:
    Manual: "el sistema muestra resumen", "el usuario revisa", "el usuario confirma", "el sistema guarda"
    Diagrama: UNA tarea "Confirmar y guardar"

MÓDULOS SIMILARES (misma app, distintas categorías):
  Cuando el manual describe módulos parecidos (Alta Mayores, Alta Menores, Alta Compra Directa),
  cada lane debe mostrar lo DIFERENTE y ÚNICO de ese módulo.
  No copiar los mismos 8 pasos genéricos en cada lane — eso no aporta valor al diagrama.
  Captura el propósito distintivo en 3-5 pasos concretos.

═══════════════════════════════════════════════════════════
REGLA 4 — FLUJO ENTRE SECCIONES Y CONECTIVIDAD OBLIGATORIA
═══════════════════════════════════════════════════════════

REGLA FUNDAMENTAL — Todos los nodos deben estar conectados:
  • Todo nodo DEBE tener al menos 1 entrada (aparecer en el "next" de algún nodo previo),
    EXCEPTO los startEvent que son el punto de origen.
  • Todo nodo DEBE tener al menos 1 salida en su propio "next",
    EXCEPTO los endEvent y endEventMessage que terminan el flujo.
  • Un nodo sin entrada es un nodo HUÉRFANO → el diagrama estará roto en Bizagi.
  • Un nodo sin salida (que no sea endEvent) es un nodo MUERTO → el flujo no avanza.

CÓMO CONECTAR LANES CORRECTAMENTE:
  El último nodo activo del lane A apunta al intermediateEvent que inicia el lane B.
  El intermediateEvent del lane B apunta a la primera tarea del lane B.

  ✅ CORRECTO:
     Lane A: ... → Task_UltimaAccion (next: ["Evt_InicioB"])
     Lane B: Evt_InicioB (next: ["Task_PrimeraB"]) → Task_PrimeraB → ... → End_LaneB

  ❌ INCORRECTO — intermediateEvent huérfano (nadie apunta a él):
     Lane A: ... → Task_UltimaAccion (next: ["End_LaneA"])   ← cierra mal con endEvent
     Lane B: Evt_InicioB (next: ["Task_PrimeraB"])            ← Evt_InicioB no tiene entrada

  ❌ INCORRECTO — endEvent con salida:
     { "id":"End_A", "type":"endEvent", "next":["Evt_B"] }   ← PROHIBIDO siempre

MENÚ QUE DISTRIBUYE A VARIOS MÓDULOS:
  Task_Menu → "next": ["Evt_ModA", "Evt_ModB", "Evt_CerrarSesion"]
  Cada Evt_Mod recibe la flecha del menú y arranca su propio flujo.
  Cada módulo termina en su propio endEvent independiente.
  No hay regreso al menú desde ningún módulo.

MÓDULO CON SUB-OPCIONES dentro del mismo lane:
  Evt_Modulo → Gateway_TipoAccion → ["Task_OpcionA", "Task_OpcionB"]
  Cada opción termina en su propio endEvent dentro del mismo lane.

REGLA ANTI-BUCLE — Cómo manejar flujos de error o reintento:
  Cuando el manual dice "si la CURP ya existe, repita el paso B", "si falla, intente de nuevo"
  o cualquier redirección de regreso a un paso anterior → NO conectar de vuelta.

  La razón es técnica: los bucles en BPMN rompen el layout en Bizagi y confunden al lector.
  En su lugar, terminar ese camino con un endEvent con nombre descriptivo del motivo.

  ✅ CORRECTO — Camino de error termina con endEvent descriptivo:
     GW_ValidarCURP → [Sí] → Task_ConfirmarDatos → ...
                    → [No] → End_CurpDuplicada

  ✅ CORRECTO — Reintento modelado como gateway:
     Task_EnviarSolicitud → GW_Enviado → [Sí] → Task_RecibirConfirmacion → End_OK
                                        → [No] → Task_ReintentarEnvio → End_FalloEnvio

  ❌ INCORRECTO — Bucle explícito (PROHIBIDO):
     GW_ValidarCURP → [No] → Task_IngresarCURP   ← regresa a nodo anterior

VERIFICACIÓN OBLIGATORIA antes de escribir el JSON:
  Para cada step, confirmar:
  1. ¿Aparece en el "next" de algún otro nodo? Si no → es huérfano, conectarlo.
  2. Si es endEvent → "next": [] y listo.
  3. Si es intermediateEvent → tiene exactamente 1 nodo que apunta a él y al menos 1 salida.
  4. Si es exclusiveGateway → tiene mínimo 2 salidas y "conditions" completo.
  5. ¿Existe algún ciclo A→B→A? → romperlo con endEvent descriptivo.

═══════════════════════════════════════════════════════════
REGLA 5 — NO INVENTAR
═══════════════════════════════════════════════════════════
Solo modela lo que el manual describe. Si algo no está claro → omítelo.
  ❌ Gateways de selección de tipo de usuario — PROHIBIDO
  ❌ Tareas o lanes no mencionados en el manual — PROHIBIDO

═══════════════════════════════════════════════════════════
REGLA 6 — REGLAS TÉCNICAS Y TIPOS DE NODO
═══════════════════════════════════════════════════════════
• Un startEvent por tipo de usuario, en su primer lane.
• IDs únicos sin espacios: Start_Xxx  Task_Xxx  GW_Xxx  Evt_Xxx  End_Xxx
• Sin referencias circulares: A → B → A está prohibido.
• exclusiveGateway con más de una salida → campo "conditions" obligatorio.
• steps[] en orden de flujo: startEvent primero.

TIPOS DE NODO — definición y reglas de nombre:

  startEvent:
    Inicio del proceso (círculo verde en Bizagi).
    Nombre CORTO, máximo 3 palabras. Describe el evento de inicio, no al actor.
    ✅ "Inicio de sesión", "Pre-registro", "Inicio"
    ❌ "Inicio del proceso de credencialización del ciudadano" — demasiado largo
    ❌ "Inicio Ciudadano" — el actor ya está en el nombre del pool/lane

  endEvent:
    Fin simple. Usar para: errores de validación, cancelaciones, fin de búsqueda,
    fin de sección sin notificación. "next": [] siempre.
    ✅ "CURP inválida", "Acceso fallido", "Código inválido", "Búsqueda finalizada"
    ❌ Nunca solo "Fin" — agrega contexto de qué terminó.

  endEventMessage:
    Fin con notificación al usuario (confirmación en pantalla, email, SMS).
    Usar cuando la operación completada genera un mensaje de confirmación visible.
    "next": [] siempre.
    ✅ "Usuario creado", "Edición guardada", "Operación completada", "Pre-registro creado"
    ❌ NO usar para errores ni para cierre de sesión.

  endEventTerminate:
    Fin que cierra el proceso COMPLETO. Usar EXCLUSIVAMENTE para cerrar sesión.
    Cuando el usuario cierra sesión, el proceso termina por completo — usar este tipo.
    "next": [] siempre.
    ✅ "Sesión cerrada" (ÚNICO caso de uso)

  endEventSignal:
    Fin que dispara o notifica a otro proceso externo.
    Usar cuando el resultado impacta un sistema externo o inicia otro proceso
    (credencial generada que activa servicios de salud, registro que notifica a SAJ).
    "next": [] siempre.
    ✅ "Credencial generada", "Alta enviada a SAJ", "Registro completado en sistema"

  userTask:
    Acción visible que el usuario ejecuta en pantalla.
    Verbo + objeto. ✅ "Ingresar credenciales", "Confirmar datos", "Adjuntar documento"

  serviceTask:
    Llamada automática a API o sistema externo (SAJ, RENAPO, etc.).
    ✅ "Consultar CURP en RENAPO", "Enviar a SAJ"

  scriptTask:
    Validación o proceso interno del sistema, sin interacción del usuario.
    ✅ "Validar formato CURP", "Verificar duplicados"

  exclusiveGateway:
    Decisión con 2 o más caminos. Nombre en forma de pregunta (máximo 5 palabras).
    ✅ "¿CURP válida?", "¿Envío exitoso?", "¿Acepta términos?"
    ❌ "Verificar si la CURP ingresada por el usuario es válida o no"
    SIEMPRE incluir "conditions" con una etiqueta corta por destino:
    Pares válidos: "Sí"/"No", "Válida"/"Inválida", "Exitoso"/"Fallido",
                   "Aprobado"/"Rechazado", "Correcto"/"Incorrecto"

  intermediateEvent:
    Conector simple entre lanes/secciones. Exactamente 1 entrada y 1 salida.
    Nombre = nombre del módulo o sección destino. Sin verbos "Iniciar", "Ir a", "Activar".
    ✅ "Verificación de cuenta", "Mis dependientes", "Cerrar sesión", "Módulo Alta"
    ❌ "Iniciar verificación de cuenta" — verbo innecesario
    El nombre debe coincidir o resumir el nombre del lane al que pertenece.

  intermediateEventMessage:
    Notificación que ocurre DENTRO del flujo (no termina el proceso).
    Usar cuando el sistema envía un mensaje al usuario y luego el flujo CONTINÚA.
    ✅ "Enviar código verificación" (el flujo continúa esperando el código)
    ✅ "Enviar alerta de error" (el flujo continúa con reintento)
    ❌ NO usar si el proceso termina después — en ese caso usar endEventMessage.

  intermediateEventMultiple:
    Hub de menú principal. Usar EXCLUSIVAMENTE para el nodo que distribuye el flujo
    a varios módulos a la vez (el menú principal después del login).
    Tiene múltiples salidas (una por cada módulo disponible).
    ✅ "Módulos", "Menú principal", "Menú principal Brigadista"
    Solo debe haber 1 por pool, en el lane de inicio de sesión.
    NOTA TÉCNICA: este nodo se renderiza como tarea de servicio (serviceTask) en el
    diagrama final, lo que mejora su legibilidad cuando hay un solo hub de distribución.

═══════════════════════════════════════════════════════════
REGLA 7 — MANUALES GRANDES (MÁS DE 5 MÓDULOS)
═══════════════════════════════════════════════════════════
Cuando el manual describe muchos módulos similares (Alta, Baja, Modificación, consultas, etc.):

1. ABSTRAE, NO COPIES:
   El diagrama no es una transcripción del manual — es un resumen ejecutivo visual.
   Si 3 módulos tienen el mismo flujo técnico, no dibujes 3 veces los mismos 8 pasos.
   Cada lane debe capturar lo que lo hace DISTINTO: qué tipo de bien, qué validación especial,
   qué autorización requiere, qué documentos genera.

2. CUENTA NODOS ANTES DE ESCRIBIR:
   Para cada lane, lista mentalmente los pasos, agrúpalos en tareas y verifica que no pasen de 7.
   Si pasas de 7 al contar → consolida más antes de escribir el JSON.

3. PASOS ADMINISTRATIVOS ESTÁNDAR → UN SOLO NODO:
   "guardar borrador / preguardar / guardar temporalmente" → "Guardar borrador"
   "enviar + reintentar si falla" → gateway + "Enviar solicitud" / "Reintentar"
   "recibir número de inventario / folio / confirmación" → "Recibir confirmación"
   "adjuntar archivo / documento" → "Adjuntar documentos" (fusionar con el paso anterior si es parte del mismo formulario)

4. LO QUE SÍ VALE LA PENA SEPARAR en módulos grandes:
   - Gateways de decisión con rutas distintas (Rechazar vs Autorizar)
   - Pasos que requieren una persona distinta (usuario vs revisor vs autorizador)
   - Generación de documentos de salida (vale, etiqueta, reporte)
   - Notificaciones externas (endEventMessage)

═══════════════════════════════════════════════════════════
REGLA 8 — JSON COMPACTO (OBLIGATORIO)
═══════════════════════════════════════════════════════════
Para evitar que la respuesta se trunque en manuales grandes, escribe cada step
en UNA SOLA LÍNEA. Esto reduce el tamaño del JSON un 35-40% sin perder datos.

  ✅ CORRECTO — una línea por step:
  {"id":"Start_A","name":"Inicio de sesión","type":"startEvent","role":"Inicio de sesión y menú","next":["Task_B"]}

  ❌ INCORRECTO — múltiples líneas por step:
  {
    "id": "Start_A",
    "name": "Inicio de sesión",
    ...
  }

Aplica este formato a TODOS los steps sin excepción.
El campo "pools" puede seguir con formato normal (son pocos elementos).

═══════════════════════════════════════════════════════════
REGLA 9 — CHECKLIST FINAL ANTES DE CERRAR EL JSON
═══════════════════════════════════════════════════════════
Antes de escribir [JSON_END], ejecuta este checklist mentalmente:

□ ¿Cada pool tiene exactamente 1 startEvent?
□ ¿Todos los endEvent tienen "next": []?
□ ¿Cada intermediateEvent aparece en el "next" de al menos 1 nodo anterior?
  → Si no → está huérfano. Conectarlo desde el último nodo del lane anterior.
□ ¿Hay algún nodo (no startEvent) cuyo id NO aparece en ningún "next" de otro nodo?
  → Si sí → ese nodo está desconectado. Conectarlo o eliminarlo.
□ ¿Algún nodo no-endEvent tiene "next": [] o "next" vacío?
  → Si sí → ese nodo es un callejón sin salida. Agregar conexión al siguiente o a endEvent.
□ ¿Algún nodo apunta a un nodo de un pool diferente?
  → Si sí → eliminar esa conexión. Los pools son completamente independientes.
□ ¿Algún exclusiveGateway tiene solo 1 salida?
  → Si sí → no es gateway, convertirlo a userTask o scriptTask.
□ ¿Existe algún ciclo directo (A→B→A) o indirecto (A→B→C→A)?
  → Si sí → romper el ciclo: el nodo final del ciclo debe ir a un endEvent descriptivo.
□ ¿El número total de lanes en todos los "pools" coincide con el número
  de valores distintos en el campo "role" de todos los steps?
  → Si no → hay roles en steps sin lane declarado o lanes sin steps. Corregir.

Solo cuando todos estén verificados, escribir [JSON_END].

═══════════════════════════════════════════════════════════
EJEMPLO REAL basado en un diagrama profesional de referencia
═══════════════════════════════════════════════════════════
Este ejemplo muestra el nivel de concisión, estructura y conectividad esperados.
Observa que CADA nodo aparece referenciado en el "next" de algún nodo anterior
(excepto los startEvent), y CADA nodo tiene salida (excepto los endEvent).

Portal Ciudadano — lanes: "Pre-registro · Recuperar contraseña · Inicio de sesión y menú · Actualizar mis datos · Unidades de Salud · Mis dependientes · Cerrar sesión"

Lane "Inicio de sesión y menú":  ← ESTRUCTURA FIJA — siempre exactamente estos 7 nodos
  Start("Inicio de sesión")
  → userTask("Ingresar credenciales")
  → scriptTask("Validar acceso")
  → Gateway("¿Acceso correcto?") →
      [No]  → endEvent("Acceso fallido")                ← endEvent simple: error
      [Sí]  → userTask("Acceso a ventana principal")
              → intermediateEventMultiple("Menú principal") →
                  [Módulo A] [Módulo B] [Cerrar sesión]  ← hub: 1 salida por módulo + cerrar

Lane "Mis dependientes":
  intermediateEvent → "Ingresar CURP dependiente" → Gateway(¿CURP registrada?) →
    [Sí]  → endEvent("CURP ya registrada")              ← endEvent simple: fin sin notif.
    [No]  → "Confirmar datos" → "Información de contacto" → "Generar credencial"
          → endEventSignal("Credencial generada")       ← signal: impacta sistema externo

Lane "Cerrar sesión":
  intermediateEvent → "Confirmar cierre" → endEventTerminate("Sesión cerrada")
                                           ← terminate: cierre de sesión SIEMPRE

Lane "Lista de usuarios" (operación con confirmación):
  intermediateEvent → "Nuevo usuario" → "Completar formulario" → "Confirmar registro"
          → endEventMessage("Usuario creado")           ← message: hay confirmación visible

Lane "Enviar código" (notificación dentro del flujo, no termina):
  ... → intermediateEventMessage("Enviar código verificación") → "Ingresar código" → ...
        ← message intermediate: el flujo CONTINÚA después de enviar

[MD_START]
**Usuarios identificados:** lista de tipos de usuario
**Lanes:** lista completa en orden
**Pasos totales:** número
**Flujo general:** 2-3 líneas resumiendo el proceso
[MD_END]
[JSON_START]
{
  "pools": [
    { "name": "Sistema X - Proceso A", "roles": ["Inicio de sesión Ciudadano", "Módulo A", "Cerrar sesión Ciudadano"] },
    { "name": "Sistema X - Proceso B", "roles": ["Inicio de sesión Brigadista", "Módulo B", "Cerrar sesión Brigadista"] }
  ],
  "steps": [
    {"id":"Start_A","name":"Inicio de sesión","type":"startEvent","role":"Inicio de sesión Ciudadano","next":["Task_Cred"]},
    {"id":"Task_Cred","name":"Ingresar credenciales","type":"userTask","role":"Inicio de sesión Ciudadano","next":["Script_Val"]},
    {"id":"Script_Val","name":"Validar acceso","type":"scriptTask","role":"Inicio de sesión Ciudadano","next":["GW_Login"]},
    {"id":"GW_Login","name":"¿Acceso correcto?","type":"exclusiveGateway","role":"Inicio de sesión Ciudadano","next":["End_Fallo","Task_Menu"],"conditions":{"End_Fallo":"No","Task_Menu":"Sí"}},
    {"id":"End_Fallo","name":"Acceso fallido","type":"endEvent","role":"Inicio de sesión Ciudadano","next":[]},
    {"id":"Task_Menu","name":"Acceso a ventana principal","type":"userTask","role":"Inicio de sesión Ciudadano","next":["Evt_Modulos"]},
    {"id":"Evt_Modulos","name":"Módulos","type":"intermediateEventMultiple","role":"Inicio de sesión Ciudadano","next":["Evt_ModA","Evt_Cerrar"]},
    {"id":"Evt_ModA","name":"Módulo A","type":"intermediateEvent","role":"Módulo A","next":["Task_AccionA"]},
    {"id":"Task_AccionA","name":"Ejecutar acción A","type":"userTask","role":"Módulo A","next":["End_ModA"]},
    {"id":"End_ModA","name":"Operación realizada","type":"endEventMessage","role":"Módulo A","next":[]},
    {"id":"Evt_Cerrar","name":"Cerrar sesión","type":"intermediateEvent","role":"Cerrar sesión Ciudadano","next":["Task_Cerrar"]},
    {"id":"Task_Cerrar","name":"Confirmar cierre","type":"userTask","role":"Cerrar sesión Ciudadano","next":["End_Sesion"]},
    {"id":"End_Sesion","name":"Sesión cerrada","type":"endEventTerminate","role":"Cerrar sesión Ciudadano","next":[]},
    {"id":"Start_B","name":"Inicio de sesión","type":"startEvent","role":"Inicio de sesión Brigadista","next":["Task_CredB"]},
    {"id":"Task_CredB","name":"Ingresar credenciales","type":"userTask","role":"Inicio de sesión Brigadista","next":["Script_ValB"]},
    {"id":"Script_ValB","name":"Validar acceso","type":"scriptTask","role":"Inicio de sesión Brigadista","next":["GW_LoginB"]},
    {"id":"GW_LoginB","name":"¿Acceso correcto?","type":"exclusiveGateway","role":"Inicio de sesión Brigadista","next":["End_FalloB","Task_MenuB"],"conditions":{"End_FalloB":"No","Task_MenuB":"Sí"}},
    {"id":"End_FalloB","name":"Acceso fallido","type":"endEvent","role":"Inicio de sesión Brigadista","next":[]},
    {"id":"Task_MenuB","name":"Acceso a ventana principal","type":"userTask","role":"Inicio de sesión Brigadista","next":["Evt_ModulosB"]},
    {"id":"Evt_ModulosB","name":"Menú principal Brigadista","type":"intermediateEventMultiple","role":"Inicio de sesión Brigadista","next":["Evt_ModB","Evt_CerrarB"]},
    {"id":"Evt_ModB","name":"Módulo B","type":"intermediateEvent","role":"Módulo B","next":["Task_AccionB"]},
    {"id":"Task_AccionB","name":"Ejecutar acción B","type":"userTask","role":"Módulo B","next":["End_ModB"]},
    {"id":"End_ModB","name":"Operación realizada","type":"endEventMessage","role":"Módulo B","next":[]},
    {"id":"Evt_CerrarB","name":"Cerrar sesión","type":"intermediateEvent","role":"Cerrar sesión Brigadista","next":["Task_CerrarB"]},
    {"id":"Task_CerrarB","name":"Confirmar cierre","type":"userTask","role":"Cerrar sesión Brigadista","next":["End_SesionB"]},
    {"id":"End_SesionB","name":"Sesión cerrada","type":"endEventTerminate","role":"Cerrar sesión Brigadista","next":[]}
  ]
}
[JSON_END]

MANUAL A ANALIZAR:
${text}`;
}

function multerErrorHandler(err, req, res, next) {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'El archivo es demasiado grande. Máximo 50 MB.' });
    if (err) return res.status(400).json({ error: err.message || 'Error al procesar el archivo.' });
    next();
}

app.post('/analyze', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) return multerErrorHandler(err, req, res, next);
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Archivo no recibido.' });

        let pdfData;
        try {
            pdfData = await pdf(req.file.buffer, { max: 0 });
        } catch (pdfErr) {
            return res.status(400).json({ error: 'No se pudo leer el PDF.' });
        }

        const rawText    = pdfData.text.replace(/\s+/g, ' ').trim();
        const manualText = rawText.substring(0, CONFIG.maxPdfChars);
        if (manualText.length < 100) return res.status(400).json({ error: 'El PDF no contiene texto extraíble.' });

        let geminiFileUri = null;
        const USE_FILE_API = req.file.size > 500 * 1024;
        if (USE_FILE_API) {
            try {
                const uploadRes = await fetch(
                    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/pdf',
                            'X-Goog-Upload-Command': 'upload, finalize',
                            'X-Goog-Upload-Header-Content-Length': req.file.size.toString(),
                            'X-Goog-Upload-Header-Content-Type': 'application/pdf',
                        },
                        body: req.file.buffer,
                    }
                );
                if (uploadRes.ok) {
                    const fileData = await uploadRes.json();
                    geminiFileUri = fileData.file?.uri;
                    console.log(`✓ PDF subido a File API: ${geminiFileUri}`);
                } else {
                    console.error(`⚠️  File API falló (${uploadRes.status}) — el manual será truncado a ${CONFIG.maxPdfChars} chars.`);
                }
            } catch (e) {
                console.error(`⚠️  File API error: ${e.message} — el manual será truncado a ${CONFIG.maxPdfChars} chars.`);
            }
        }

        console.log(`PDF: ${req.file.size} bytes, ${pdfData.numpages} pág.`);
        const t0 = Date.now();

        const model = genAI.getGenerativeModel({
            model: CONFIG.model,
            generationConfig: { temperature: CONFIG.temperature, maxOutputTokens: CONFIG.maxTokens },
        });

        async function callGemini(promptText) {
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    let result;
                    if (geminiFileUri) {
                        result = await model.generateContent([
                            promptText.replace(/\nMANUAL A ANALIZAR:\n[\s\S]*$/, '\nMANUAL A ANALIZAR: [Ver PDF adjunto]'),
                            { fileData: { mimeType: 'application/pdf', fileUri: geminiFileUri } },
                        ]);
                    } else {
                        result = await model.generateContent(promptText);
                    }
                    return result.response.text();
                } catch(e) {
                    const msg = e.message || '';
                    const retry = (msg.includes('503') || msg.includes('429')) && attempt < 3;
                    if (retry) {
                        const wait = (attempt + 1) * 20000;
                        console.warn(`Gemini saturado — esperando ${wait/1000}s...`);
                        await new Promise(r => setTimeout(r, wait));
                    } else throw e;
                }
            }
        }

        const raw = await callGemini(buildPrompt(manualText));
        console.log(`Gemini respondió en ${((Date.now() - t0)/1000).toFixed(1)}s`);

        const mdMatch   = raw.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);
        const jsonMatch = raw.match(/\[JSON_START\]([\s\S]*?)\[JSON_END\]/);
        let rawJson = jsonMatch ? jsonMatch[1] : null;

        // ✅ FIX DIAGRAMAS GRANDES: si el JSON fue truncado, hacer una segunda llamada
        // pidiendo a Gemini que continúe exactamente desde donde se cortó.
        if (!rawJson) {
            const partial = raw.match(/\[JSON_START\]([\s\S]*)/);
            if (partial) {
                console.warn('Respuesta truncada — solicitando continuación a Gemini...');
                const partialJson = partial[1].trim();
                // Construir prompt de continuación con el JSON parcial
                const continuationPrompt = `El JSON anterior fue cortado por límite de tokens. Continúa EXACTAMENTE desde donde se cortó, sin repetir nada de lo anterior. Escribe SOLO la continuación del JSON (el fragmento que falta) y termina con [JSON_END].

JSON parcial hasta donde llegaste:
${partialJson}

Continúa a partir de aquí:`;
                try {
                    const raw2 = await callGemini(continuationPrompt);
                    console.log(`Continuación recibida (${raw2.length} chars)`);
                    // Extraer la continuación — puede tener [JSON_END] o no
                    const cont = raw2.replace(/\[JSON_END\].*$/s, '').trim();
                    rawJson = partialJson + '\n' + cont;
                    console.warn('JSON reconstruido por continuación.');
                } catch (contErr) {
                    console.warn(`Continuación falló: ${contErr.message} — usando JSON parcial`);
                    rawJson = partialJson;
                }
            }
        }
        if (!rawJson) throw new Error('Gemini no devolvió JSON válido. Intenta de nuevo.');

        let structure;
        try {
            let js = rawJson.replace(/```json|```/g, '').trim();
            js = js.replace(/\/\/[^\n\r"]*/g, '');
            js = js.replace(/\/\*[\s\S]*?\*\//g, '');
            js = js.replace(/,\s*([}\]])/g, '$1');
            if (!js.trimEnd().endsWith('}')) {
                const lb = js.lastIndexOf('}');
                if (lb > 0) { js = js.substring(0, lb + 1) + '\n  ]\n}'; console.warn('JSON cerrado automáticamente.'); }
            }
            structure = JSON.parse(js);
        } catch (e) { throw new Error(`JSON inválido: ${e.message}`); }

        if (!structure.roles?.length && structure.pools?.length) {
            structure.roles = structure.pools.flatMap(p => p.roles || []);
            console.log('roles derivados de pools[]: ' + structure.roles.length + ' roles');
        }
        if (!structure.roles?.length || !structure.steps?.length) throw new Error('Sin roles o pasos válidos.');

        const validIds = new Set(structure.steps.map(s => s.id));

        if (structure.pools?.length > 1) {
            const rolePoolIdx = {};
            structure.pools.forEach((pool, pi) => {
                (pool.roles || []).forEach(r => {
                    if (!rolePoolIdx[r]) rolePoolIdx[r] = [];
                    rolePoolIdx[r].push(pi);
                });
            });
            Object.entries(rolePoolIdx).forEach(([r, pis]) => {
                if (pis.length < 2) return;
                pis.forEach((pi, occurrence) => {
                    const newName = r + ' · ' + (pi + 1);
                    structure.pools[pi].roles = structure.pools[pi].roles.map(x => x === r ? newName : x);
                    if (occurrence === 0) {
                        structure.steps.forEach(s => { if (s.role === r) s.role = newName; });
                        console.warn(`PRE-FIX: "${r}" → "${newName}" (pool ${pi})`);
                    } else {
                        console.warn(`PRE-FIX: pool ${pi} reclama "${r}" → "${newName}" (sin pasos, FIX9 lo maneja)`);
                    }
                });
            });
            structure.roles = structure.pools.flatMap(p => p.roles);
            console.warn('PRE-FIX roles: ' + structure.roles.length + ' roles tras normalización');
        }

        // FIX 0: AUTO-SPLIT lanes con > 7 nodos lineales
        {
            const MAX_LANE_NODES = 7;
            const bridgeIds = new Set();
            let pass = 0, changed = true;
            while (changed && pass < 10) {
                changed = false; pass++;
                {
                    const seen = new Set();
                    structure.steps = structure.steps.filter(s => {
                        if (seen.has(s.id)) return false;
                        seen.add(s.id); return true;
                    });
                }
                const newRoles = [], newSteps = [];
                structure.roles.forEach((role, roleIdx) => {
                    const laneSteps = structure.steps.filter(s => s.role === role);
                    const realCount = laneSteps.filter(s => !bridgeIds.has(s.id)).length;
                    if (realCount <= MAX_LANE_NODES) {
                        newRoles.push(role); laneSteps.forEach(s => newSteps.push(s)); return;
                    }
                    const laneIds = new Set(laneSteps.map(s => s.id));
                    const laneIdxMap = {};
                    laneSteps.forEach((s, i) => { laneIdxMap[s.id] = i; });
                    let hasCycle = false;
                    laneSteps.forEach(s => {
                        (s.next || []).forEach(nid => {
                            if (laneIds.has(nid) && laneIdxMap[nid] < laneIdxMap[s.id]) hasCycle = true;
                        });
                    });
                    if (hasCycle) { newRoles.push(role); laneSteps.forEach(s => newSteps.push(s)); return; }
                    changed = true;
                    const base = role.replace(/\s*-\s*Parte\s*[\d\.]+$/i, '').trim();
                    const p1n = `${base} - Parte ${roleIdx}.1`, p2n = `${base} - Parte ${roleIdx}.2`;
                    const p1s = laneSteps.slice(0, MAX_LANE_NODES), p2s = laneSteps.slice(MAX_LANE_NODES);
                    const safeBase = base.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
                    const bid = `EvtBr_${safeBase}_${pass}`;

                    // El target del bridge debe ser un nodo con proceso real (no endEvent).
                    // Si p2s[0] es endEvent el bridge quedaría vacío (EvtBr→endEvent sin tareas).
                    const isEndType = t => t === 'endEvent' || t === 'endEventMessage' ||
                                          t === 'endEventTerminate' || t === 'endEventSignal';
                    const bridgeTarget = p2s.find(s => !isEndType(s.type));
                    if (!bridgeTarget) {
                        // p2s solo tiene endEvents — no tiene sentido dividir este lane
                        console.warn(`FIX0: lane "${role}" p2s sin nodos activos, split omitido`);
                        newRoles.push(role); laneSteps.forEach(s => newSteps.push(s));
                        changed = false; return;
                    }

                    bridgeIds.add(bid);
                    const bridge = { id: bid, name: `Continuar ${base.split(' ').slice(-2).join(' ')}`, type: 'intermediateEvent', role: p2n, next: [bridgeTarget.id] };
                    const lastConnectable = [...p1s].reverse().find(s => !isEndType(s.type));
                    if (lastConnectable && !(lastConnectable.next || []).includes(bid)) {
                        lastConnectable.next = [...(lastConnectable.next || []), bid];
                    } else if (!lastConnectable) {
                        console.warn(`FIX0: lane "${role}" todos endEvents, bridge omitido`);
                        bridgeIds.delete(bid);
                        newRoles.push(role); laneSteps.forEach(s => newSteps.push(s));
                        changed = false; return;
                    }
                    p1s.forEach(s => { s.role = p1n; }); p2s.forEach(s => { s.role = p2n; });
                    newRoles.push(p1n, p2n);
                    p1s.forEach(s => newSteps.push(s)); newSteps.push(bridge); p2s.forEach(s => newSteps.push(s));
                    console.warn(`FIX0: "${role}" → "${p1n}" + "${p2n}"`);
                });
                if (changed) {
                    structure.roles = newRoles;
                    structure.steps = newSteps;
                    if (structure.pools?.length) {
                        structure.pools.forEach(pool => {
                            const updated = [];
                            pool.roles.forEach(origRole => {
                                const replacements = newRoles.filter(nr =>
                                    nr === origRole || nr.startsWith(origRole + ' - Parte ')
                                );
                                if (replacements.length) updated.push(...replacements);
                                else updated.push(origRole);
                            });
                            pool.roles = [...new Set(updated)];
                        });
                        console.warn('FIX0-pools: structure.pools actualizado con roles divididos');
                    }
                }
            }
        }

        // FIX 1: endEvent sin next
        structure.steps.forEach(step => {
            const isEnd = step.type === 'endEvent' || step.type === 'endEventMessage' ||
                          step.type === 'endEventTerminate' || step.type === 'endEventSignal';
            if (isEnd && step.next?.length) { step.next = []; console.warn(`FIX1: ${step.id}`); }
        });

        // FIX 1b: eliminar ciclos bidireccionales directos
        {
            const stepMapCycle = {};
            structure.steps.forEach(s => { stepMapCycle[s.id] = s; });
            structure.steps.forEach(step => {
                (step.next || []).forEach(nid => {
                    const target = stepMapCycle[nid];
                    if (!target) return;
                    if ((target.next || []).includes(step.id)) {
                        target.next = target.next.filter(n => n !== step.id);
                        console.warn(`FIX1b: ciclo eliminado ${nid}->${step.id}`);
                    }
                });
            });
        }

        // FIX 2: referencias inexistentes
        structure.steps.forEach(step => {
            step.next = (step.next || []).filter(nid => { if (!validIds.has(nid)) { console.warn(`FIX2: ${step.id}→${nid} eliminado`); return false; } return true; });
        });

        // FIX 3: roles desconocidos
        structure.steps.forEach(step => {
            if (!structure.roles.includes(step.role)) { console.warn(`FIX3: rol desconocido "${step.role}"`); step.role = structure.roles[0]; }
        });

        // FIX 4: gateway sin salidas
        structure.steps.forEach((step, idx) => {
            if (step.type === 'exclusiveGateway' && !(step.next?.length)) {
                const candidates = [];
                for (let i = idx + 1; i < structure.steps.length && candidates.length < 2; i++) {
                    if (structure.steps[i].role === step.role) candidates.push(structure.steps[i].id);
                }
                if (!candidates.length) for (let i = idx + 1; i < structure.steps.length && candidates.length < 2; i++) candidates.push(structure.steps[i].id);
                if (candidates.length) {
                    step.next = candidates;
                    if (!step.conditions) step.conditions = {};
                    candidates.forEach((id, i) => { if (!step.conditions[id]) step.conditions[id] = i === 0 ? 'Sí' : 'No'; });
                    console.warn(`FIX4: gateway ${step.id} → ${candidates}`);
                }
            }
        });

        // FIX 5: nodos huérfanos
        {
            const hub = structure.steps.find(s => s.type === 'intermediateEvent' && (s.next || []).length > 1);
            structure.roles.forEach((role, ri) => {
                if (ri === 0) return;
                const laneSteps = structure.steps.filter(s => s.role === role);
                if (!laneSteps.length) return;
                const currentTargets = new Set(structure.steps.flatMap(s => s.next || []));
                const isEndType = t => t === 'endEvent' || t === 'endEventMessage' ||
                                       t === 'endEventTerminate' || t === 'endEventSignal';
                const orphans = laneSteps.filter(s =>
                    !currentTargets.has(s.id) &&
                    !isEndType(s.type)
                );
                orphans.forEach(orphan => {
                    const updatedTargets = new Set(structure.steps.flatMap(s => s.next || []));
                    if (updatedTargets.has(orphan.id)) return;
                    if (orphan.type === 'startEvent') {
                        orphan.type = 'intermediateEvent';
                        console.warn(`FIX5: startEvent→intermediate ${orphan.id}`);
                    }
                    if (hub && !hub.next.includes(orphan.id) && orphan.type === 'intermediateEvent') {
                        hub.next.push(orphan.id); console.warn(`FIX5B: hub→${orphan.id}`); return;
                    }
                    if (ri > 0) {
                        const prevLane = structure.steps.filter(s => s.role === structure.roles[ri - 1]);
                        const connector = [...prevLane].reverse().find(s => !s.type?.startsWith('endEvent'));
                        if (connector && !connector.next.includes(orphan.id)) {
                            connector.next.push(orphan.id); console.warn(`FIX5C: ${connector.id}→${orphan.id}`);
                        }
                    }
                });
            });
        }

        // FIX 6: nodos sin salida
        structure.steps.forEach((step, idx) => {
            const isEndEvt = step.type === 'endEvent' || step.type === 'endEventMessage' ||
                             step.type === 'endEventTerminate' || step.type === 'endEventSignal';
            if (isEndEvt || step.type === 'exclusiveGateway') return;
            if ((step.next || []).length > 0) return;
            const nextInLane = structure.steps.slice(idx + 1).find(n => n.role === step.role);
            if (nextInLane) { step.next = [nextInLane.id]; console.warn(`FIX6: ${step.id}→${nextInLane.id}`); return; }
            const laneHasEnd = structure.steps.some(n => n.role === step.role &&
                (n.type === 'endEvent' || n.type === 'endEventMessage' ||
                 n.type === 'endEventTerminate' || n.type === 'endEventSignal'));
            if (!laneHasEnd) {
                const endId = `End_Auto_${step.id}`;
                structure.steps.push({ id: endId, name: 'Fin', type: 'endEvent', role: step.role, next: [] });
                step.next = [endId]; console.warn(`FIX6: endEvent auto ${endId}`);
            }
        });

        // FIX 9: garantizar startEvent en cada pool
        {
            const poolDefs = structure.pools || null;
            const poolGroups = poolDefs
                ? poolDefs.map(p => ({ name: p.name, roles: p.roles }))
                : [{ name: null, roles: structure.roles }];

            poolGroups.forEach(({ name, roles: poolRoles }) => {
                const poolSteps = structure.steps.filter(s => poolRoles.includes(s.role));
                if (!poolSteps.length) return;
                if (poolSteps.some(s => s.type === 'startEvent')) return;
                const poolIds = new Set(poolSteps.map(s => s.id));
                const targets = new Set(poolSteps.flatMap(s => s.next || []).filter(id => poolIds.has(id)));
                const firstNode = poolSteps.find(s => !targets.has(s.id)) || poolSteps[0];
                if (firstNode && firstNode.type !== 'startEvent') {
                    const alreadyHasStart = poolSteps.some(s => s.type === 'startEvent');
                    firstNode.type = alreadyHasStart ? 'intermediateEvent' : 'startEvent';
                    structure.steps.forEach(s => {
                        if (!poolRoles.includes(s.role) && (s.next || []).includes(firstNode.id)) {
                            s.next = s.next.filter(n => n !== firstNode.id);
                            console.warn(`FIX9: cross-pool eliminado: ${s.id}→${firstNode.id}`);
                        }
                    });
                    console.warn(`FIX9: ${firstNode.id}→startEvent`);
                }
            });
        }

        // ─── ENSAMBLADO GENÉRICO DE N POOLS ────────────────────────────────
        {
            const allSteps = structure.steps;
            const ts = Date.now();

            let poolDefs;
            if (structure.pools?.length) {
                const assignedRoles = new Set(structure.pools.flatMap(p => p.roles));
                const unassigned = structure.roles.filter(r => !assignedRoles.has(r));
                if (unassigned.length) {
                    structure.pools[structure.pools.length - 1].roles.push(...unassigned);
                    console.warn(`FIX: ${unassigned.length} roles sin pool → agregados al último`);
                }
                poolDefs = structure.pools;
            } else {
                poolDefs = [{ name: 'Proceso de Negocio', roles: structure.roles }];
            }

            const poolConfigs = poolDefs.map((pool, i) => ({
                name:      pool.name || `Proceso ${i + 1}`,
                roles:     pool.roles,
                steps:     allSteps.filter(s => pool.roles.includes(s.role)),
                processId: `Process_${ts + i}`,
                poolId:    `Participant_${i + 1}`,
                lanePrefix: i === 0 ? '' : String.fromCharCode(65 + i - 1),
            }));

            const logicXml = poolConfigs
                .map(pc => generateLogic({ roles: pc.roles, steps: pc.steps }, pc.processId, pc.lanePrefix))
                .join('\n');

            let currentY = 60;
            const diParts = [];
            poolConfigs.forEach(pc => {
                const di = generateDI(
                    { roles: pc.roles, steps: pc.steps },
                    pc.processId,
                    { poolY: currentY, poolId: pc.poolId, poolName: pc.name, lanePrefix: pc.lanePrefix }
                );
                diParts.push(di);
                currentY += di.poolH + 60;
            });

            const allShapes = diParts.map(d => d.shapesXml).join('');
            const allEdges  = diParts.map(d => d.edgesXml).join('');

            const diXml = `  <bpmndi:BPMNDiagram id="BPMNDiagram_1" name="Proceso de Negocio">
    <bpmndi:BPMNPlane id="BPMNDiagram_1_Plane" bpmnElement="Collaboration_1">
${allShapes}${allEdges}    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>`;

            const participantsXml = poolConfigs
                .map(pc => `    <participant id="${pc.poolId}" name="${xmlEscape(pc.name)}" processRef="${pc.processId}"/>`)
                .join('\n');

            const collaborationXml = `  <collaboration id="Collaboration_1">\n${participantsXml}\n  </collaboration>`;

            const finalXml = `<?xml version="1.0" encoding="utf-8"?>
<definitions
  xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  xsi:schemaLocation="http://www.omg.org/spec/BPMN/20100524/MODEL http://www.omg.org/spec/BPMN/20100524/MODEL/BPMN20.xsd"
  id="Definitions_1"
  targetNamespace="http://www.bizagi.com/definitions/20250226143500"
  exporter="Bizagi Modeler"
  exporterVersion="3.4.0.013">
${collaborationXml}
${logicXml}
${diXml}
</definitions>`;

            poolConfigs.forEach(pc =>
                console.log(`✓ Pool "${pc.name}": ${pc.steps.length} pasos, ${pc.roles.length} lanes`)
            );
            console.log(`✓ BPMN generado — ${allSteps.length} pasos totales, ${poolDefs.length} pool(s)`);
            res.json({
                success: true,
                data:    mdMatch ? mdMatch[1].trim() : 'Análisis completado.',
                bpmn:    finalXml,
                bpmns:   [{ name: 'Proceso de Negocio', bpmn: finalXml }]
            });
        }

    } catch (error) {
        console.error('Error crítico:', error.message);
        res.status(500).json({ error: error.message });
    }
});

const server = app.listen(4000, () => console.log(`Servidor IA en puerto 4000 — modelo: ${CONFIG.model}`));
server.timeout = CONFIG.timeout;
server.keepAliveTimeout = CONFIG.timeout;
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
    maxPdfChars: 280_000,   // subido de 120k — gemini-2.5-flash soporta ~200k tokens de contexto
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
// generateLogic — sin cambios
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
            case 'exclusiveGateway':
                xml = `    <exclusiveGateway id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </exclusiveGateway>`; break;
            case 'userTask':
                xml = `    <userTask id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </userTask>`; break;
            case 'serviceTask':
                xml = `    <serviceTask id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </serviceTask>`; break;
            case 'scriptTask':
                xml = `    <scriptTask id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </scriptTask>`; break;
            case 'intermediateEvent':
                xml = `    <intermediateCatchEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </intermediateCatchEvent>`; break;
            case 'intermediateEventMessage':
                xml = `    <intermediateThrowEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n      <messageEventDefinition/>\n    </intermediateThrowEvent>`; break;
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
// generateDI — versión 2.0 (layout profesional)
//
// PRINCIPIOS del diagrama de referencia profesional:
//  1. Nodos pequeños (start/end/intermediate/gateway) tienen tamaño reducido
//  2. El espaciado horizontal es moderado (~180-220px center-to-center entre tasks)
//  3. Las salidas de gateways se distribuyen VERTICALMENTE dentro del lane
//  4. Las flechas cross-lane salen por ABAJO del nodo fuente y entran por ARRIBA
//  5. El ancho del pool se calcula en base al contenido real
//  6. La altura de cada lane se calcula en base a las filas necesarias
// ─────────────────────────────────────────────────────────────────────────────
function generateDI(structure, processId, poolOpts = {}) {
    const { roles, steps } = structure;
    const POOL_ID    = poolOpts.poolId    ?? 'Participant_1';
    const POOL_Y     = poolOpts.poolY     ?? 60;
    const LANE_PFX   = poolOpts.lanePrefix ?? '';
    const NODE_PFX   = LANE_PFX === '' ? 'p0_' : `p${LANE_PFX}_`;
    const npid       = id => `${NODE_PFX}${id}`;
    const nfid       = (s, t) => `Flow_${NODE_PFX}${s}_${NODE_PFX}${t}`;

    // ── Tamaños de nodos ────────────────────────────────────────────────────
    const NODE_SIZE = {
        startEvent:               { w: 36,  h: 36  },
        endEvent:                 { w: 36,  h: 36  },
        endEventMessage:          { w: 36,  h: 36  },
        exclusiveGateway:         { w: 44,  h: 44  },
        parallelGateway:          { w: 44,  h: 44  },
        task:                     { w: 110, h: 60  },
        userTask:                 { w: 110, h: 60  },
        serviceTask:              { w: 110, h: 60  },
        scriptTask:               { w: 110, h: 60  },
        intermediateEvent:        { w: 36,  h: 36  },
        intermediateEventMessage: { w: 36,  h: 36  },
    };
    const sz       = type => NODE_SIZE[type] || NODE_SIZE.task;
    const isSmall  = type => ['startEvent','endEvent','endEventMessage',
                              'intermediateEvent','intermediateEventMessage'].includes(type);
    const isGW     = type => type?.includes('Gateway');
    const isTask   = type => !isSmall(type) && !isGW(type);

    // ── Constantes de espaciado horizontal center-to-center ─────────────────
    // Basado en mediciones del diagrama profesional de referencia
    const H_GAP = {
        'small→small': 140,
        'small→task' : 160,
        'small→gw'   : 150,
        'task→small' : 130,
        'task→task'  : 205,
        'task→gw'    : 165,
        'gw→task'    : 165,
        'gw→small'   : 130,
        'gw→gw'      : 150,
    };
    const getHGap = (srcType, dstType) => {
        const sKey = isSmall(srcType) ? 'small' : (isGW(srcType) ? 'gw' : 'task');
        const dKey = isSmall(dstType) ? 'small' : (isGW(dstType) ? 'gw' : 'task');
        return H_GAP[`${sKey}→${dKey}`] ?? 190;
    };

    // ── Constantes de layout vertical ──────────────────────────────────────
    const ROW_H         = 135;   // px entre centros de fila dentro de un lane
    const LANE_PAD_TOP  = 75;    // margen superior dentro del lane
    const LANE_PAD_BOT  = 65;    // margen inferior dentro del lane
    const LANE_MIN_H    = 260;   // altura mínima de cualquier lane
    const POOL_X        = 160;
    const LABEL_W       = 30;
    const LANE_X        = POOL_X + LABEL_W;   // 190
    const LANE_LEFT_PAD = 85;    // padding izquierdo desde el borde del lane al primer cx

    // ── Mapa de pasos ───────────────────────────────────────────────────────
    const stepMap = {};
    steps.forEach(s => { stepMap[s.id] = s; });

    // ── PASO 1: Asignar columnas por BFS dentro de cada lane ────────────────
    // Primero detectamos back-edges (ciclos de feedback) para ignorarlos
    // al calcular columnas — evita que A→B→GW→ERR→A infle la columna de A.
    const nodeCol = {};
    steps.forEach(s => { nodeCol[s.id] = 0; });

    roles.forEach(role => {
        const laneSteps = steps.filter(s => s.role === role);
        if (!laneSteps.length) return;
        const laneIds = new Set(laneSteps.map(s => s.id));

        // DFS para detectar back-edges
        const backEdges = new Set();
        const dfsMark = {};  // 0=unvisited 1=in-stack 2=done
        const dfs = id => {
            if (dfsMark[id] === 2) return;
            dfsMark[id] = 1;
            (stepMap[id]?.next || []).forEach(nid => {
                if (!laneIds.has(nid)) return;
                if (dfsMark[nid] === 1) backEdges.add(`${id}->${nid}`);
                else if (!dfsMark[nid]) dfs(nid);
            });
            dfsMark[id] = 2;
        };
        laneSteps.forEach(s => { if (!dfsMark[s.id]) dfs(s.id); });

        // In-degree ignorando back-edges
        const inDeg = {};
        laneSteps.forEach(s => { inDeg[s.id] = 0; });
        laneSteps.forEach(s => {
            (s.next || []).forEach(nid => {
                if (laneIds.has(nid) && !backEdges.has(`${s.id}->${nid}`))
                    inDeg[nid] = (inDeg[nid] || 0) + 1;
            });
        });

        const queue = laneSteps.filter(s => inDeg[s.id] === 0).map(s => s.id);
        if (!queue.length) queue.push(laneSteps[0].id);
        const visited = new Set();

        while (queue.length) {
            const id = queue.shift();
            if (visited.has(id)) continue;
            visited.add(id);
            (stepMap[id]?.next || []).forEach(nid => {
                if (!laneIds.has(nid) || backEdges.has(`${id}->${nid}`)) return;
                const newCol = (nodeCol[id] || 0) + 1;
                if (newCol > (nodeCol[nid] || 0)) nodeCol[nid] = newCol;
                if (!visited.has(nid)) queue.push(nid);
            });
        }
        // Nodos no alcanzados → al final
        const maxUsed = Math.max(0, ...laneSteps.map(s => nodeCol[s.id] || 0));
        laneSteps.forEach(s => { if (!visited.has(s.id)) nodeCol[s.id] = maxUsed + 1; });
    });

    // ── PASO 2: Asignar filas (branching vertical) ──────────────────────────
    // Los gateways con múltiples salidas dentro del mismo lane distribuyen
    // sus salidas en filas distintas. Esto evita que las flechas se apilen.
    const nodeRow = {};
    steps.forEach(s => { nodeRow[s.id] = 0; });

    roles.forEach(role => {
        const laneSteps = steps.filter(s => s.role === role);
        const laneIds = new Set(laneSteps.map(s => s.id));

        // Ordenar por columna para procesar de izquierda a derecha
        const sorted = [...laneSteps].sort((a, b) => (nodeCol[a.id] || 0) - (nodeCol[b.id] || 0));

        sorted.forEach(step => {
            if (!isGW(step.type)) return;
            const laneOuts = (step.next || []).filter(nid => laneIds.has(nid));
            if (laneOuts.length < 2) return;

            const gwRow = nodeRow[step.id] || 0;

            // Propagación de fila hacia adelante por cada rama
            const propagateRow = (startId, row) => {
                const q = [startId];
                const vis = new Set();
                while (q.length) {
                    const cid = q.shift();
                    if (vis.has(cid) || !laneIds.has(cid)) continue;
                    vis.add(cid);
                    // Solo avanzar la fila si es mayor a la actual
                    if ((nodeRow[cid] || 0) < row) nodeRow[cid] = row;
                    (stepMap[cid]?.next || [])
                        .filter(n => laneIds.has(n) && !vis.has(n))
                        .forEach(n => q.push(n));
                }
            };

            laneOuts.forEach((nid, i) => {
                propagateRow(nid, gwRow + i);
            });
        });
    });

    // ── PASO 3: Calcular posiciones X por columna por lane ──────────────────
    // Para cada lane acumulamos la posición X de cada columna teniendo en
    // cuenta el tipo de nodo fuente y destino.
    const colCX = {};  // `${role}__${col}` → center X

    roles.forEach(role => {
        const laneSteps = steps.filter(s => s.role === role);
        if (!laneSteps.length) return;

        const maxCol = Math.max(0, ...laneSteps.map(s => nodeCol[s.id] || 0));

        // Tipo "representativo" de cada columna = el nodo de mayor anchura
        const colRepType = {};
        laneSteps.forEach(s => {
            const col = nodeCol[s.id] || 0;
            if (!colRepType[col] || sz(s.type).w > sz(colRepType[col]).w) {
                colRepType[col] = s.type;
            }
        });

        let cx = LANE_X + LANE_LEFT_PAD;
        colCX[`${role}__0`] = cx;

        for (let col = 0; col < maxCol; col++) {
            const srcType = colRepType[col]  || 'userTask';
            const dstType = colRepType[col + 1] || 'userTask';
            cx += getHGap(srcType, dstType);
            colCX[`${role}__${col + 1}`] = cx;
        }
    });

    // ── PASO 4: Alturas de lane y posición Y ───────────────────────────────
    // La altura se calcula con ROW_REF_H (60px) para que sea consistente con el CY fijo.
    // Fórmula: padTop + (rows-1)*ROW_H + ROW_REF_H + padBot
    // 1 fila: 75 + 0 + 60 + 65 = 200 → max(260, 200) = 260px
    // 2 filas: 75 + 135 + 60 + 65 = 335px
    // 3 filas: 75 + 270 + 60 + 65 = 470px
    const ROW_REF_H = 60;  // definida aquí, también usada en PASO 5
    const laneRowCount = {};
    roles.forEach(role => {
        const laneSteps = steps.filter(s => s.role === role);
        if (!laneSteps.length) { laneRowCount[role] = 1; return; }
        laneRowCount[role] = Math.max(1, ...laneSteps.map(s => (nodeRow[s.id] || 0) + 1));
    });

    const laneH = {};
    const laneY = {};
    let curY = POOL_Y;

    roles.forEach((role, ri) => {
        const rows = laneRowCount[role] || 1;
        const h = LANE_PAD_TOP + (rows - 1) * ROW_H + ROW_REF_H + LANE_PAD_BOT;
        laneH[ri] = Math.max(LANE_MIN_H, h);
        laneY[ri] = curY;
        curY += laneH[ri];
    });
    const poolH = curY - POOL_Y;

    // ── PASO 5: Posiciones pixel de cada nodo ─────────────────────────────
    // IMPORTANTE: el CY de cada fila es FIJO e independiente del tamaño del nodo.
    // Sin esto, startEvent (h=36), gateway (h=44) y task (h=60) en la misma fila
    // obtendrían CY distintos (153, 157, 165) causando desalineación y flechas torcidas.
    const pos = {};
    steps.forEach(s => {
        const { w, h } = sz(s.type);
        const ri  = roles.indexOf(s.role);
        if (ri < 0) return;
        const col = nodeCol[s.id] ?? 0;
        const row = nodeRow[s.id] ?? 0;
        const cx  = colCX[`${s.role}__${col}`] ?? (LANE_X + LANE_LEFT_PAD + col * 200);
        // CY fijo por fila: todos los nodos de row=N comparten el mismo centro Y
        const cy  = laneY[ri] + LANE_PAD_TOP + ROW_REF_H / 2 + row * ROW_H;
        pos[s.id] = {
            x:  Math.round(cx - w / 2),
            y:  Math.round(cy - h / 2),   // centrado verticalmente sobre el CY de la fila
            w, h,
            cx: Math.round(cx),
            cy: Math.round(cy),
        };
    });

    // ── Ancho del pool ─────────────────────────────────────────────────────
    const maxRight = steps.reduce((m, s) => {
        const p = pos[s.id];
        return p ? Math.max(m, p.x + p.w) : m;
    }, LANE_X + 400);
    const poolW = Math.max(800, maxRight + 120);

    // ── Helpers ────────────────────────────────────────────────────────────
    const P   = id => pos[id];
    const CX  = id => pos[id]?.cx ?? 0;
    const CY  = id => pos[id]?.cy ?? 0;
    const L   = id => pos[id]?.x ?? 0;
    const R   = id => (pos[id]?.x ?? 0) + (pos[id]?.w ?? 0);
    const T   = id => pos[id]?.y ?? 0;
    const BOT = id => (pos[id]?.y ?? 0) + (pos[id]?.h ?? 0);
    const wpt = pts => pts
        .map(([x, y]) => `        <di:waypoint x="${Math.round(x)}" y="${Math.round(y)}"/>`)
        .join('\n');

    // ── SHAPES ─────────────────────────────────────────────────────────────
    let shapes = `      <bpmndi:BPMNShape id="${POOL_ID}_di" bpmnElement="${POOL_ID}" isHorizontal="true">
        <dc:Bounds x="${POOL_X}" y="${POOL_Y}" width="${poolW}" height="${poolH}"/>
      </bpmndi:BPMNShape>\n`;

    roles.forEach((_, i) => {
        shapes += `      <bpmndi:BPMNShape id="Lane_${LANE_PFX}${i}_di" bpmnElement="Lane_${LANE_PFX}${i}" isHorizontal="true">
        <dc:Bounds x="${LANE_X}" y="${laneY[i]}" width="${poolW - LABEL_W}" height="${laneH[i]}"/>
      </bpmndi:BPMNShape>\n`;
    });

    steps.forEach(s => {
        const p = P(s.id);
        if (!p) return;
        shapes += `      <bpmndi:BPMNShape id="Shape_${npid(s.id)}" bpmnElement="${npid(s.id)}">
        <dc:Bounds x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>
      </bpmndi:BPMNShape>\n`;
    });

    // ── EDGES ──────────────────────────────────────────────────────────────
    // Estrategia de routing:
    //
    // A) Mismo lane, misma fila, avance → flecha horizontal simple
    // B) Mismo lane, misma fila, retroceso → arco por encima del lane
    // C) Mismo lane, fila distinta → curva en L (derecha + baja)
    // D) Cross-lane → salida por abajo, horizontal en mid-gap, entrada por arriba
    //
    let edges = '';

    steps.forEach(step => {
        if (!P(step.id)) return;
        const srcRi  = roles.indexOf(step.role);
        const srcRow = nodeRow[step.id] ?? 0;

        (step.next || []).forEach((targetId, outIdx) => {
            if (!P(targetId)) return;
            const tgt    = stepMap[targetId];
            if (!tgt) return;
            const tgtRi  = roles.indexOf(tgt.role);
            const tgtRow = nodeRow[targetId] ?? 0;
            const tgtCol = nodeCol[targetId] ?? 0;
            const srcCol = nodeCol[step.id] ?? 0;

            const edgeId = `Edge_${npid(step.id)}_${npid(targetId)}`;
            const flowId = nfid(step.id, targetId);
            const condText = step.conditions?.[targetId];

            let pts = [];

            if (srcRi === tgtRi) {
                // ── Mismo lane ────────────────────────────────────────────
                if (srcRow === tgtRow) {
                    if (CX(targetId) > CX(step.id)) {
                        // A) Avance simple
                        pts = [
                            [R(step.id),  CY(step.id)],
                            [L(targetId), CY(targetId)],
                        ];
                    } else {
                        // B) Retroceso — arco por encima del lane
                        const arcY = laneY[srcRi] + 14;
                        pts = [
                            [R(step.id),       CY(step.id)],
                            [R(step.id) + 14,  CY(step.id)],
                            [R(step.id) + 14,  arcY],
                            [L(targetId) - 14, arcY],
                            [L(targetId) - 14, CY(targetId)],
                            [L(targetId),      CY(targetId)],
                        ];
                    }
                } else {
                    // C) Distinta fila dentro del mismo lane
                    if (tgtCol > srcCol) {
                        // Target a la derecha y en otra fila:
                        // Salir por derecha del nodo, bajar/subir al CY destino, entrar izquierda
                        // Usar pequeño offset para separar flechas múltiples del mismo gateway
                        const xOff = R(step.id) + 18 + outIdx * 14;
                        pts = [
                            [R(step.id),  CY(step.id)],
                            [xOff,        CY(step.id)],
                            [xOff,        CY(targetId)],
                            [L(targetId), CY(targetId)],
                        ];
                    } else {
                        // Mismo X o target a la izquierda y distinta fila
                        const midX = (CX(step.id) + CX(targetId)) / 2;
                        pts = [
                            [R(step.id),  CY(step.id)],
                            [midX,        CY(step.id)],
                            [midX,        CY(targetId)],
                            [L(targetId), CY(targetId)],
                        ];
                    }
                }
            } else {
                // ── Cross-lane (D) ────────────────────────────────────────
                // Salida por ABAJO del nodo fuente
                // Baja al mid-gap entre lanes
                // Giro horizontal hasta CX del target
                // Sube hasta ARRIBA del target
                const outCount = (step.next || []).filter(nid => {
                    const t = stepMap[nid];
                    return t && roles.indexOf(t.role) !== srcRi;
                }).length;
                const crossIdx = (step.next || [])
                    .filter(nid => { const t = stepMap[nid]; return t && roles.indexOf(t.role) !== srcRi; })
                    .indexOf(targetId);
                const spread  = Math.min(outCount - 1, 4) * 18;
                const offsetX = outCount > 1
                    ? CX(step.id) - spread / 2 + crossIdx * (spread / Math.max(outCount - 1, 1))
                    : CX(step.id);

                const tgtCX    = CX(targetId);
                const midGapY  = (laneY[srcRi] + laneH[srcRi] + laneY[tgtRi]) / 2;

                if (Math.abs(offsetX - tgtCX) < 5) {
                    pts = [
                        [offsetX, BOT(step.id)],
                        [offsetX, T(targetId)],
                    ];
                } else {
                    pts = [
                        [offsetX, BOT(step.id)],
                        [offsetX, midGapY],
                        [tgtCX,   midGapY],
                        [tgtCX,   T(targetId)],
                    ];
                }
            }

            // Label de condición
            let labelXml = '';
            if (condText) {
                const labelW = Math.min(condText.length * 7 + 10, 120);
                const lx = Math.round(pts[0][0] + 4);
                const ly = Math.round(pts[0][1] - 22);
                labelXml = `\n        <bpmndi:BPMNLabel><dc:Bounds x="${lx}" y="${ly}" width="${labelW}" height="20"/></bpmndi:BPMNLabel>`;
            }

            edges += `      <bpmndi:BPMNEdge id="${edgeId}" bpmnElement="${flowId}">${labelXml}
${wpt(pts)}
      </bpmndi:BPMNEdge>\n`;
        });
    });

    return { poolH, shapesXml: shapes, edgesXml: edges };
}

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
REGLA 4 — FLUJO ENTRE SECCIONES
═══════════════════════════════════════════════════════════
• endEvent / endEventMessage → "next": [] siempre. Nunca conecta a otro nodo.
• intermediateEvent → conector entre secciones. Exactamente 1 entrada y 1 salida.
• PROHIBIDO conectar nodos entre usuarios distintos (Ciudadano ↔ Brigadista).

CONECTAR SECCIONES:
  ✅ última_tarea_lane1 → intermediateEvent_inicio_lane2 → primera_tarea_lane2
  ❌ endEvent → intermediateEvent   (endEvent no puede conectar)
  ❌ intermediateEvent sin nada que apunte a él (nodo huérfano)

MENÚ CON MÓDULOS:
  Task_Menu → "next": ["Evt_ModA", "Evt_ModB", "Evt_CerrarSesion"]
  Cada Evt_Mod → tareas del módulo → endEvent  (no regresa al menú)

MÓDULO CON SUB-OPCIONES (ej: Gestión de usuarios tiene Crear, Editar, Buscar):
  Evt_Gestion → "next": ["Task_Crear", "Task_Editar", "Task_Buscar"]
  Cada opción termina en su propio endEvent.

═══════════════════════════════════════════════════════════
REGLA 5 — NO INVENTAR
═══════════════════════════════════════════════════════════
Solo modela lo que el manual describe. Si algo no está claro → omítelo.
  ❌ Gateways de selección de tipo de usuario — PROHIBIDO
  ❌ Tareas o lanes no mencionados en el manual — PROHIBIDO

═══════════════════════════════════════════════════════════
REGLA 6 — REGLAS TÉCNICAS
═══════════════════════════════════════════════════════════
• Un startEvent por tipo de usuario, en su primer lane.
• IDs únicos sin espacios: Start_Xxx  Task_Xxx  GW_Xxx  Evt_Xxx  End_Xxx
• Sin referencias circulares: A → B → A está prohibido.
• exclusiveGateway con más de una salida → campo "conditions" obligatorio.
• steps[] en orden de flujo: startEvent primero.

TIPOS DE NODO:
  startEvent               → Inicio del proceso (un círculo verde). Nombre corto y directo: "Inicio de sesión", "Pre-registro", "Inicio". NUNCA "Inicio Ciudadano" ni "Inicio del proceso de X".
  endEvent                 → Fin de sección. "next": [] siempre.
  endEventMessage          → Fin con notificación (email, SMS). "next": [] siempre.
  userTask                 → Acción del usuario en pantalla.
  serviceTask              → Llamada a API o sistema externo.
  scriptTask               → Validación o proceso interno del sistema.
  exclusiveGateway         → Decisión. Requiere "conditions" por cada salida.
  intermediateEvent        → Conector entre secciones. Nombre = el módulo o sección destino, SIN "Iniciar", SIN "Inicio de". Ejemplos: "Pre-registro", "Mis dependientes", "Módulos", "Cerrar sesión". NUNCA "Iniciar pre-registro" ni "Inicio del módulo".
  intermediateEventMessage → Notificación dentro del flujo (envío de código, alerta). Nombre descriptivo corto: "Enviar código", "Código enviado".

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
  {"id":"Start_A","name":"Inicio","type":"startEvent","role":"Login","next":["Task_B"]}

  ❌ INCORRECTO — múltiples líneas por step:
  {
    "id": "Start_A",
    "name": "Inicio",
    ...
  }

Aplica este formato a TODOS los steps sin excepción.
El campo "pools" puede seguir con formato normal (son pocos elementos).

═══════════════════════════════════════════════════════════
EJEMPLO REAL basado en un diagrama profesional de referencia
═══════════════════════════════════════════════════════════
Este ejemplo muestra el nivel de concisión y estructura esperados:

Portal Ciudadano — lanes: "Pre-registro · Recuperar contraseña · Inicio de sesión y menú · Actualizar mis datos · Unidades de Salud · Mis dependientes · Cerrar sesión"

Lane "Inicio de sesión y menú":
  Start → "Ingresar credenciales" → "Validar acceso" → Gateway(Correcto/Incorrecto) →
    [Incorrecto] → "Solicitar nuevo código" → vuelve a Validar
    [Correcto]   → "Acceso a ventana principal" → IntermediateEvent(Módulos) →
      [Módulo A] [Módulo B] [Módulo C] [Cerrar sesión]

Lane "Mis dependientes":
  IntEvt → "Nuevo dependiente" → Gateway(¿Registrado?) →
    [Registrado]     → "Mensaje informativo" (endEventMessage)
    [No registrado]  → "Confirmar datos" → Gateway(¿Acepta?) →
      [No] → fin
      [Sí] → "Información de contacto" → "Generar credencial" → fin

[MD_START]
**Usuarios identificados:** lista de tipos de usuario
**Lanes:** lista completa en orden
**Pasos totales:** número
**Flujo general:** 2-3 líneas resumiendo el proceso
[MD_END]
[JSON_START]
{
  "pools": [
    { "name": "Sistema X - Proceso A", "roles": ["Inicio de sesión y menú", "Módulo A", "Cerrar sesión"] },
    { "name": "Sistema X - Proceso B", "roles": ["Inicio de sesión y menú B", "Módulo B", "Cerrar sesión B"] }
  ],
  "steps": [
    { "id": "Start_A", "name": "Inicio de sesión", "type": "startEvent", "role": "Inicio de sesión y menú", "next": ["Task_Credenciales"] },
    { "id": "Task_Credenciales", "name": "Ingresar credenciales", "type": "userTask", "role": "Inicio de sesión y menú", "next": ["Script_Validar"] },
    { "id": "Script_Validar", "name": "Validar acceso", "type": "scriptTask", "role": "Inicio de sesión y menú", "next": ["GW_Login"] },
    { "id": "GW_Login", "name": "¿Acceso correcto?", "type": "exclusiveGateway", "role": "Inicio de sesión y menú", "next": ["Task_ErrorLogin", "Task_Menu"], "conditions": {"Task_ErrorLogin": "No", "Task_Menu": "Sí"} },
    { "id": "Task_ErrorLogin", "name": "Mostrar error de acceso", "type": "userTask", "role": "Inicio de sesión y menú", "next": ["Task_Credenciales"] },
    { "id": "Task_Menu", "name": "Acceso a ventana principal", "type": "userTask", "role": "Inicio de sesión y menú", "next": ["Evt_ModA", "Evt_Cerrar"] },
    { "id": "Evt_ModA", "name": "Módulo A", "type": "intermediateEvent", "role": "Módulo A", "next": ["Task_AccionA"] },
    { "id": "Task_AccionA", "name": "Ejecutar acción A", "type": "userTask", "role": "Módulo A", "next": ["End_ModA"] },
    { "id": "End_ModA", "name": "Operación realizada", "type": "endEventMessage", "role": "Módulo A", "next": [] },
    { "id": "Evt_Cerrar", "name": "Cerrar sesión", "type": "intermediateEvent", "role": "Cerrar sesión", "next": ["Task_Cerrar"] },
    { "id": "Task_Cerrar", "name": "Confirmar cierre", "type": "userTask", "role": "Cerrar sesión", "next": ["End_Sesion"] },
    { "id": "End_Sesion", "name": "Cerrar sesión", "type": "endEvent", "role": "Cerrar sesión", "next": [] },
    { "id": "Start_B", "name": "Inicio de sesión", "type": "startEvent", "role": "Inicio de sesión y menú B", "next": ["Task_CredB"] },
    { "id": "Task_CredB", "name": "Ingresar credenciales", "type": "userTask", "role": "Inicio de sesión y menú B", "next": ["Evt_ModB", "Evt_CerrarB"] },
    { "id": "Evt_ModB", "name": "Módulo B", "type": "intermediateEvent", "role": "Módulo B", "next": ["Task_AccionB"] },
    { "id": "Task_AccionB", "name": "Ejecutar acción B", "type": "userTask", "role": "Módulo B", "next": ["End_ModB"] },
    { "id": "End_ModB", "name": "Operación realizada", "type": "endEventMessage", "role": "Módulo B", "next": [] },
    { "id": "Evt_CerrarB", "name": "Cerrar sesión", "type": "intermediateEvent", "role": "Cerrar sesión B", "next": ["Task_CerrarB"] },
    { "id": "Task_CerrarB", "name": "Confirmar cierre", "type": "userTask", "role": "Cerrar sesión B", "next": ["End_SesionB"] },
    { "id": "End_SesionB", "name": "Cerrar sesión", "type": "endEvent", "role": "Cerrar sesión B", "next": [] }
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
                    console.error(`⚠️  File API falló (${uploadRes.status}) — el manual será truncado a ${CONFIG.maxPdfChars} chars. El diagrama puede omitir módulos del final.`);
                }
            } catch (e) {
                console.error(`⚠️  File API error: ${e.message} — el manual será truncado a ${CONFIG.maxPdfChars} chars. El diagrama puede omitir módulos del final.`);
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
        if (!rawJson) {
            const partial = raw.match(/\[JSON_START\]([\s\S]*)/);
            if (partial) { console.warn('Respuesta truncada — reparando...'); rawJson = partial[1]; }
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
                    bridgeIds.add(bid);
                    const bridge = { id: bid, name: `Continuar ${base.split(' ').slice(-2).join(' ')}`, type: 'intermediateEvent', role: p2n, next: [p2s[0].id] };
                    const last = p1s[p1s.length - 1];
                    if (last.type?.startsWith('endEvent') && !(last.next || []).length) { last.type = 'intermediateEvent'; last.next = [bid]; }
                    else if (!last.type?.startsWith('endEvent') && !(last.next || []).includes(bid)) { last.next = [...(last.next || []), bid]; }
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
            if (step.type?.startsWith('endEvent') && step.next?.length) { step.next = []; console.warn(`FIX1: ${step.id}`); }
        });

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
                const orphans = laneSteps.filter(s => !currentTargets.has(s.id));
                orphans.forEach(orphan => {
                    const updatedTargets = new Set(structure.steps.flatMap(s => s.next || []));
                    if (updatedTargets.has(orphan.id)) return;
                    if (orphan.type === 'startEvent') { orphan.type = 'intermediateEvent'; console.warn(`FIX5: startEvent→intermediate ${orphan.id}`); }
                    const samelaneFinalizer = laneSteps.find(s => s !== orphan && s.type?.startsWith('endEvent') && !(s.next || []).length && !updatedTargets.has(orphan.id));
                    if (samelaneFinalizer && orphan.type === 'intermediateEvent') {
                        samelaneFinalizer.type = 'intermediateEvent'; samelaneFinalizer.next = [orphan.id];
                        console.warn(`FIX5A: ${samelaneFinalizer.id}→${orphan.id}`); return;
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
            if (step.type?.startsWith('endEvent') || step.type === 'exclusiveGateway') return;
            if ((step.next || []).length > 0) return;
            const nextInLane = structure.steps.slice(idx + 1).find(n => n.role === step.role);
            if (nextInLane) { step.next = [nextInLane.id]; console.warn(`FIX6: ${step.id}→${nextInLane.id}`); return; }
            const laneHasEnd = structure.steps.some(n => n.role === step.role && n.type?.startsWith('endEvent'));
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

        // FIX 10: eliminar intermediateEvents relay redundantes
        {
            const bridgePattern = /^EvtBr_/;
            let removed = true;
            while (removed) {
                removed = false;
                const toRemove = new Set();
                const stepMap2 = {};
                structure.steps.forEach(s => { stepMap2[s.id] = s; });

                structure.steps.forEach(step => {
                    if (step.type !== 'intermediateEvent' && step.type !== 'intermediateEventMessage') return;
                    if (bridgePattern.test(step.id)) return;
                    const outs = step.next || [];
                    if (outs.length !== 1) return;
                    const ins = structure.steps.filter(s => (s.next || []).includes(step.id));
                    if (ins.length !== 1) return;
                    const src = ins[0];
                    const tgt = outs[0];
                    if (src.role === step.role) return;
                    src.next = src.next.map(n => n === step.id ? tgt : n);
                    if (src.conditions?.[step.id]) {
                        src.conditions[tgt] = src.conditions[tgt] || src.conditions[step.id];
                        delete src.conditions[step.id];
                    }
                    toRemove.add(step.id);
                    console.warn(`FIX10: relay eliminado ${step.id} ("${step.name}") ${src.id}→${tgt}`);
                    removed = true;
                });

                if (toRemove.size) {
                    structure.steps = structure.steps.filter(s => !toRemove.has(s.id));
                    structure.roles = structure.roles.filter(r =>
                        structure.steps.some(s => s.role === r)
                    );
                    if (structure.pools) {
                        structure.pools.forEach(pool => {
                            pool.roles = pool.roles.filter(r => structure.steps.some(s => s.role === r));
                        });
                    }
                }
            }
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
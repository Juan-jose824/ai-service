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

// COnfirguración de multer para manejo de archivos PDF en memoria, con limite de 50 MB y filtro para aceptar solo PDFs.
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

// Inicialización del cliente de Google Generative AI con la clave API proporcionada en las variables de entorno.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Configuración de parámetros para las llamadas al modelo de lenguaje, incluyendo el modelo a usar, limites de caracteres, tokens y tiempo de espera.
const CONFIG = {
    model:       'gemini-2.5-flash',
    maxPdfChars: 280_000,
    maxTokens:   65_536,
    temperature: 0,
    timeout:     180_000,
};

// Función para escapar caracteres especiales en XML, asegurando que el texto se renderice correctamente en el diagrama BPMN.
function xmlEscape(str) {
    return (str || '')
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&apos;');
}

// ─────────────────────────────────────────────────────────────────────────────
// generateLogic — genera la sección <process> del BPMN a partir de la estructura detectada
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
                xml = `    <intermediateCatchEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </intermediateCatchEvent>`; break;
            case 'intermediateEventMessage':
                xml = `    <intermediateThrowEvent id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n      <messageEventDefinition/>\n    </intermediateThrowEvent>`; break;
            case 'intermediateEventMultiple':
                xml = `    <serviceTask id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </serviceTask>`; break;
            default:
                xml = `    <task id="${sid}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </task>`;
        }
        return xml;
    }).join('\n');

    // Anotaciones de rol por sección — renderizadas como textAnnotation conectadas al primer nodo del lane
    const annotationElements = [];
    steps.forEach(step => {
        if (!step.annotation) return;
        const annId  = `Ann_${pid(step.id)}`;
        const assocId = `Assoc_${pid(step.id)}`;
        // El separador " | " divide rol de campos — renderizar como líneas separadas
        const annText = step.annotation.replace(/\s*\|\s*/g, '\n');
        annotationElements.push(
            `    <textAnnotation id="${annId}">\n      <text>${xmlEscape(annText)}</text>\n    </textAnnotation>`,
            `    <association id="${assocId}" sourceRef="${sid(step)}" targetRef="${annId}"/>`
        );
    });

    // SECUENCIAS helper local para sid en anotaciones
    function sid(step) { return `${pfx}${step.id}`; }

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
${annotationElements.join('\n')}
${sequences}
  </process>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// generateDI — genera las secciones <bpmndi:BPMNDiagram> y <bpmndi:BPMNPlane> con posiciones calculadas para cada nodo, pool, lane y edges con routing profesional
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

    // Función para calcular el gap horizontal recomendado entre dos nodos según sus tipos, considerando combinaciones de eventos, tareas y gateways para optimizar el espacio visual y evitar encimamientos.
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

    // Constantes de dimensiones y posiciones base para el pool, lanes y labels, que sirven como referencia para calcular las posiciones de cada nodo y el tamaño total del diagrama.
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
    const nodeCol = {};
    steps.forEach(s => { nodeCol[s.id] = 0; });

    roles.forEach(role => {
        const ls = steps.filter(s => s.role === role);
        if (!ls.length) return;
        const laneIds = new Set(ls.map(s => s.id));

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

        const inDeg = {};
        ls.forEach(s => { inDeg[s.id] = 0; });

        ls.forEach(s => {
            (s.next || []).forEach(nid => {
                if (laneIds.has(nid) && !backEdges.has(`${s.id}->${nid}`))
                    inDeg[nid] = (inDeg[nid] || 0) + 1;
            });
        });

        steps.forEach(s => {
            if (laneIds.has(s.id)) return;
            (s.next || []).forEach(nid => {
                if (laneIds.has(nid))
                    inDeg[nid] = (inDeg[nid] || 0) + 1;
            });
        });

        // BFS para asignar columnas, partiendo de nodos sin predecesores (inDeg=0) y evitando back edges para no romper ciclos intencionales.
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

        // POST-BFS: resolver encimamientos en la misma columna dentro del lane.
        // Si hay un intermediateEvent (bridge de entrada) en col=0 junto a otros nodos
        // también en col=0, el bridge siempre va a col=0 y los demás se desplazan.
        const col0Nodes = ls.filter(s => (nodeCol[s.id] || 0) === 0);
        if (col0Nodes.length > 1) {
            const bridgeInLane = col0Nodes.find(s => s.type === 'intermediateEvent');
            if (bridgeInLane) {
                // El bridge se queda en col 0; todos los demás en col 0 pasan a col 1+
                col0Nodes.forEach(s => {
                    if (s.id !== bridgeInLane.id) {
                        nodeCol[s.id] = 1;
                        // Propagar el desplazamiento en el grafo del lane
                        const q2 = [s.id]; const vis2 = new Set([bridgeInLane.id]);
                        while (q2.length) {
                            const cid = q2.shift();
                            if (vis2.has(cid)) continue;
                            vis2.add(cid);
                            (stepMap[cid]?.next || []).forEach(nid => {
                                if (!laneIds.has(nid) || vis2.has(nid)) return;
                                const nc2 = (nodeCol[cid] || 0) + 1;
                                if (nc2 > (nodeCol[nid] || 0)) {
                                    nodeCol[nid] = nc2;
                                    q2.push(nid);
                                }
                            });
                        }
                    }
                });
            }
        }
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

    // Calcular altura real necesaria considerando la posición Y máxima de
    // cualquier nodo dentro del lane (cy + h/2 + LANE_PAD_BOT).
    // Esto evita que nodos en fila secundaria (row > 0) queden encimados
    // con el siguiente lane.
    const laneH = {}, laneY = {};
    let curY = POOL_Y;
    roles.forEach((role, ri) => {
        const rows = laneRowCount[role] || 1;
        // Altura base por filas
        const baseH = LANE_PAD_TOP + (rows - 1) * ROW_GAP + 45 + LANE_PAD_BOT;
        // Margen extra de seguridad cuando hay más de 1 fila (nodos desplazados)
        const safetyH = rows > 1 ? (rows - 1) * 25 : 0;
        laneH[ri] = Math.max(LANE_MIN_H, baseH + safetyH);
        laneY[ri] = curY;
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

    // ── SHAPES — posición y tamaño de cada nodo, pool y lane ─────────────────────────
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

    // ── SHAPES de anotaciones ─────────────────────────────────────────────────
    steps.forEach(s => {
        if (!s.annotation) return;
        const p = P(s.id);
        if (!p) return;
        const annId = `Ann_${npid(s.id)}`;
        // Contar líneas lógicas: separador | divide rol de campos
        const parts = s.annotation.split('|');
        const totalLen = s.annotation.length;
        // Tamaño de caja según cantidad de contenido
        const annW = totalLen > 60 ? 200 : totalLen > 40 ? 160 : 110;
        const lineCount = parts.length + (totalLen > 80 ? 1 : 0);
        const annH = lineCount >= 2 ? 55 : totalLen > 30 ? 42 : 30;
        // Posicionar la anotación arriba del nodo
        const annX = Math.round(p.cx - annW / 2);
        const annY = Math.round(p.y - annH - 18);
        shapes += `      <bpmndi:BPMNShape id="${annId}_di" bpmnElement="${annId}">
        <dc:Bounds x="${annX}" y="${annY}" width="${annW}" height="${annH}"/>
      </bpmndi:BPMNShape>\n`;
    });

    /* ── EDGES — rutas entre nodos con cálculo profesional de waypoints para evitar cruces y encimamientos, 
    considerando la posición relativa de los nodos (misma fila, misma columna, diferentes lanes) y el tipo de 
    conexión (condicional o no).
    */
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

            // Si la conexión tiene una condición, agregar un label con el texto de la condición cerca del nodo de origen, evitando cruces con la línea.
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

    /* Edges de anotaciones — conectar cada anotación con su nodo correspondiente usando una línea recta desde el centro 
    inferior de la anotación al centro superior del nodo, asegurando que el texto de la anotación no cruce con la línea.
    */
    steps.forEach(s => {
        if (!s.annotation) return;
        const p = P(s.id);
        if (!p) return;
        const assocId = `Assoc_${npid(s.id)}`;
        const annId   = `Ann_${npid(s.id)}`;
        const annW    = s.annotation.length > 40 ? 160 : 100;
        const annH    = s.annotation.length > 40 ? 60  : 36;
        const annCX   = Math.round(p.cx);
        const annBotY = Math.round(p.y - 20);
        edges += `      <bpmndi:BPMNEdge id="${assocId}_di" bpmnElement="${assocId}">
        <di:waypoint x="${annCX}" y="${annBotY}"/>
        <di:waypoint x="${p.cx}" y="${p.y}"/>
      </bpmndi:BPMNEdge>\n`;
    });

    return { poolH, shapesXml: shapes, edgesXml: edges };
}

// ─────────────────────────────────────────────────────────────────────────────
/*
buildPrompt — genera el prompt completo para la generación del diagrama BPMN, incluyendo instrucciones detalladas sobre la 
filosofía de diseño, reglas de representación de roles y módulos, y pasos previos obligatorios para asegurar que el 
diagrama sea claro, completo y profesional, listo para ser presentado a un director de área sin necesidad de explicación 
adicional.
*/
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
FILOSOFÍA: MENOS ES MÁS, PERO COMPLETO
═══════════════════════════════════════════════════════════
El diagrama debe comunicar el PROPÓSITO y el FLUJO COMPLETO de cada sección.
Un director debe leerlo y entender exactamente qué hace el usuario en cada paso.

ANTES DE ESCRIBIR CADA TAREA, hazte esta pregunta:
  "¿Qué LOGRA el usuario en este paso?" → eso es el nombre de la tarea.
  "¿Cómo hace clic en la pantalla?" → eso NO va en el diagrama.

Los procesos deben ser COMPLETOS — incluir todas las acciones relevantes que
el usuario realiza: acceder a una sección, buscar o filtrar registros, seleccionar
un elemento, ingresar datos, confirmar, generar documentos, etc.
No omitir pasos solo por simplificar — si el manual lo menciona, debe estar.

═══════════════════════════════════════════════════════════
═══════════════════════════════════════════════════════════
REGLA 0 — ROLES: UN POOL POR SISTEMA, ANOTACIÓN POR SECCIÓN (CRÍTICO)
═══════════════════════════════════════════════════════════
PRINCIPIO FUNDAMENTAL — UN POOL POR SISTEMA:
  Aunque el manual describa múltiples roles o perfiles (Brigadista, Director
  de Área, Coordinador Estatal, Administrador, etc.), el diagrama debe tener
  UN SOLO POOL por sistema o aplicación.

  Los roles se indican mediante ANOTACIONES en los nodos relevantes del diagrama.
  Esto hace el diagrama más limpio, compacto y fácil de presentar.

ESTRUCTURA CORRECTA para sistema con múltiples roles:
  → UN pool: nombre del sistema (sin mencionar roles en el nombre del pool)
  → Cada lane: nombre del módulo o sección (no el nombre del rol)
  → Anotación en el primer nodo de cada lane: indica qué rol(es) acceden

  EJEMPLO CORRECTO — Herramienta con 3 roles (Brigadista, Director, Coordinador):
    Pool: "Herramienta Brigadista"
    Lane "Inicio de sesión":
      Task "Ingresar credenciales" → annotation: "Brigadista · Director de Área · Coordinador Estatal"
    Lane "Gestión de usuarios":
      intermediateEvent → annotation: "Rol: Brigadista"
    Lane "Aprobar solicitudes":
      intermediateEvent → annotation: "Rol: Director de Área · Coordinador Estatal"
    Lane "Reportes":
      intermediateEvent → annotation: "Rol: Coordinador Estatal"

  EJEMPLO INCORRECTO — Crear un pool por rol:
    Pool 1 "Herramienta Brigadista - Brigadista"    ← INCORRECTO
    Pool 2 "Herramienta Brigadista - Director"       ← INCORRECTO
    Pool 3 "Herramienta Brigadista - Coordinador"    ← INCORRECTO

DÓNDE AGREGAR LA ANOTACIÓN DE ROL:
  • En el lane de inicio de sesión: en Task "Ingresar credenciales",
    listar TODOS los roles del sistema separados por " · "
    Ejemplo: annotation: "Brigadista · Director de Área · Coordinador Estatal"
  • En cada lane de módulo: en el intermediateEvent de entrada del lane,
    indicar el/los roles con acceso. Formato: "Rol: NombreRol"
    Si aplica a todos los roles → no agregar anotación de rol
    Si aplica a un rol específico → "Rol: Brigadista"
    Si aplica a varios pero no todos → "Rol: Director · Coordinador"

EXCEPCIÓN — Cuándo sí crear múltiples pools:
  Solo cuando el manual describe APLICACIONES O SISTEMAS COMPLETAMENTE DISTINTOS
  (ej: "Portal Ciudadano" y "Herramienta Brigadista" son apps diferentes → 2 pools).
  Distintos roles dentro del MISMO sistema → siempre un solo pool con anotaciones.

CÓMO IDENTIFICAR ROLES EN EL MANUAL:
  • Lee todos los encabezados y secciones buscando perfiles de usuario
  • Usa los nombres exactos del manual: "Responsable de Bienes", "Jefe de Área", etc.
  • PROHIBIDO: "Usuario", "Actor", "Persona", "Rol 1" — siempre nombres reales del manual
  • Si el manual no distingue roles → no agregar anotación de rol

NOMBRE DEL POOL: nombre del sistema o aplicación, sin mencionar roles.
  ✅ "Portal de Credencialización" · "Herramienta Brigadista" · "SICSSE - Activos Fijos"
  ❌ "Herramienta Brigadista - Brigadista" · "Portal - Director de Área"

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

Verbos preferidos: Ingresar · Validar · Confirmar · Seleccionar · Crear · Editar
                   Buscar · Filtrar · Registrar · Cerrar · Acceder · Generar
                   Enviar · Descargar · Consultar · Adjuntar · Revisar

PROHIBIDO: Presionar · Pulsar · Tocar · Dar clic · Hacer clic · Botón · Ícono

ANTI-PATRÓN — Secuencias técnicas repetitivas:
  Consolidar "guardar borrador", "enviar al sistema", "reintentar si falla",
  "recibir confirmación" en máximo 2 tareas:
    "Registrar solicitud" + Gateway(¿Exitoso?) → "Recibir confirmación" / "Reintentar envío"

═══════════════════════════════════════════════════════════
REGLA 1B — PROCESOS COMPLETOS POR SECCIÓN (NUEVO - CRÍTICO)
═══════════════════════════════════════════════════════════
Cada lane de módulo debe incluir TODAS las acciones que el usuario realiza
en esa sección, en el nivel correcto de abstracción:

  ✅ NIVEL CORRECTO — acciones funcionales completas:
     "Acceder a sección X"
     "Buscar por [criterio del manual: CURP, nombre, folio, fecha…]"
     "Filtrar resultados"
     "Seleccionar registro"
     "Completar formulario"
     "Adjuntar documentos"
     "Confirmar y guardar"
     "Generar reporte / comprobante"
     "Descargar documento"

  ❌ DEMASIADO DETALLADO (nivel de interfaz — prohibido):
     "Presionar el botón Buscar"
     "Se desplegará una lista con los resultados"
     "Hacer clic en el ícono de lupa"

  ❌ DEMASIADO RESUMIDO (omite pasos importantes):
     Un solo nodo "Gestionar dependientes" cuando el manual describe:
     acceder, buscar, seleccionar, ingresar CURP, verificar, agregar, confirmar.

REGLA DE ORO: Si el manual dedica un párrafo o más a describir los pasos
de una acción dentro de un módulo, esa acción merece su propio nodo en el diagrama.
Si solo menciona la acción de pasada en una línea, puede ir agrupada.

═══════════════════════════════════════════════════════════
REGLA 2 — ANOTACIONES: CAMPOS DE FORMULARIO Y ROLES DE ACCESO (NUEVO)
═══════════════════════════════════════════════════════════
El campo "annotation" en un step sirve para DOS propósitos:
  1. Indicar los CAMPOS de un formulario que el usuario debe llenar
  2. Indicar el ROL o roles que tienen acceso a esa sección

── TIPO A: Anotación de CAMPOS DE FORMULARIO ──────────────────────────────────
Agregar en userTask que involucra ingreso de datos.

CUÁNDO agregar:
  • userTask de login, registro, búsqueda, formularios
  • Cuando el manual menciona campos específicos que el usuario ingresa

CUÁNDO NO agregar:
  • Gateways, eventos, scriptTask, tareas de solo confirmación
  • Cuando el manual no especifica campos concretos

FORMATO:
  • 1-3 campos cortos → separados por " · "  →  "CURP · Contraseña"
  • 4-6 campos → igual formato  →  "Nombre · CURP · Correo · Teléfono · Estado"
  • Más de 6 → agrupar por categoría  →  "Datos personales · Datos de contacto"
  • Solo campos mencionados explícitamente en el manual. NUNCA inventar campos.

── TIPO B: Anotación de ROL DE ACCESO ─────────────────────────────────────────
Agregar cuando el manual tiene múltiples roles y una sección es exclusiva de uno.

CUÁNDO agregar:
  • En Task "Ingresar credenciales" del login: listar TODOS los roles del sistema
  • En el intermediateEvent de entrada de cada lane de módulo: indicar rol(es)
    que tienen acceso, cuando NO todos los roles del sistema acceden a ese módulo

CUÁNDO NO agregar anotación de rol:
  • Si el módulo es accesible por TODOS los roles del sistema → no agregar
  • Si el manual solo tiene un rol → no agregar

FORMATO de anotación de rol:
  • Todos los roles (en login):  "Brigadista · Director de Área · Coordinador Estatal"
  • Un rol específico:  "Rol: Brigadista"
  • Varios roles específicos:  "Rol: Director de Área · Coordinador Estatal"

── COMBINACIÓN: un step puede tener campos Y rol ──────────────────────────────
Si un step tiene tanto campos como restricción de rol, el annotation combina ambos:
  "Rol: Brigadista | CURP · Nombre · Correo"
  (separar con " | " para distinguir rol de campos)

EJEMPLOS:

Step de login con anotación de roles (todos los roles):
  {"id":"Task_Login","name":"Ingresar credenciales","type":"userTask","role":"Inicio de sesión","next":["Script_Val"],"annotation":"Brigadista · Director de Área · Coordinador Estatal | Usuario · Contraseña"}

Step de formulario con campos (solo campos, módulo accesible por todos):
  {"id":"Task_Reg","name":"Completar formulario","type":"userTask","role":"Registro","next":["GW_Val"],"annotation":"Nombre · Apellidos · CURP · Fecha nacimiento · Correo"}

Step de entrada de módulo con rol específico:
  {"id":"Evt_Aprobar","name":"Aprobar solicitudes","type":"intermediateEvent","role":"Aprobar solicitudes","next":["Task_Revisar"],"annotation":"Rol: Director de Área · Coordinador Estatal"}

Step sin anotación (gateway):
  {"id":"GW_Val","name":"¿Datos válidos?","type":"exclusiveGateway","role":"Registro","next":["End_Error","Task_Confirm"],"conditions":{"End_Error":"No","Task_Confirm":"Sí"}}

═══════════════════════════════════════════════════════════
REGLA 3 — POOLS Y LANES (OBLIGATORIA)
═══════════════════════════════════════════════════════════
UN POOL = un actor, sistema o proceso diferenciado en el manual.
El campo "pools" del JSON define cuántos diagramas se generarán — uno por pool.

CUÁNDO crear múltiples pools:
  SOLO cuando el manual describe SISTEMAS O APLICACIONES COMPLETAMENTE DISTINTOS.
  Ejemplo: "Portal Ciudadano" y "Herramienta Brigadista" son aplicaciones
  diferentes → sí merecen pools separados.

  REGLA CLAVE — pool vs lane vs anotación:
  • Distintas APLICACIONES/SISTEMAS → pools separados
  • Distintos MÓDULOS del mismo sistema → lanes del mismo pool
  • Distintos ROLES dentro del mismo sistema → UN pool + anotaciones de rol en cada lane

  EJEMPLO CORRECTO — mismo sistema, múltiples roles:
    Pool único: "Herramienta Brigadista"
    Lanes: "Inicio de sesión" · "Gestión usuarios" · "Aprobar solicitudes" · "Cerrar sesión"
    → Los roles se indican en anotaciones, NO en pools separados.

  EJEMPLO INCORRECTO:
    Pool 1 "Herramienta Brigadista - Brigadista"
    Pool 2 "Herramienta Brigadista - Director de Área"
    → NUNCA crear un pool por cada rol del mismo sistema.

CUÁNDO crear un solo pool:
  • Siempre que todos los módulos pertenezcan al mismo sistema/aplicación,
    sin importar cuántos roles distintos tenga ese sistema.

NOMBRE DEL POOL: nombre real del sistema + rol exacto del manual. Ejemplos:
  "Portal Ciudadano" · "Herramienta Brigadista" · "SICSSE - Responsable de Bienes"
  PROHIBIDO: "Proceso de Negocio", "Pool 1", "Pool A", nombres genéricos.

ESTRUCTURA DE LANES dentro de cada pool:
  1. Primer lane: startEvent + login + menú principal
  2. [Un lane por cada módulo/sección, con el nombre exacto del módulo]
  3. Último lane: cierre de sesión

LANE DE INICIO DE SESIÓN — ESTRUCTURA FIJA (OBLIGATORIA):
  El lane de inicio de sesión tiene EXACTAMENTE estos 7 nodos — ni uno más, ni uno menos.

    startEvent("Inicio de sesión")
    → userTask("Ingresar credenciales") [annotation: "Usuario · Contraseña" o campos reales del manual]
    → scriptTask("Validar acceso")
    → exclusiveGateway("¿Acceso correcto?")
        → [No]  endEvent("Acceso fallido")
        → [Sí]  userTask("Acceso a ventana principal")
                → intermediateEventMultiple("Menú principal")

  ❌ PROHIBIDO ABSOLUTAMENTE en el lane de inicio de sesión:
     • Agregar módulos del sistema (importación, consulta, registro, etc.)
     • Superar los 7 nodos bajo ninguna circunstancia
     • Los módulos siempre van en su propio lane separado

  ❌ PROHIBIDO: crear lanes sin ningún nodo (lanes vacíos).
     Si un módulo no tiene pasos claros en el manual → omitirlo, no crear lane vacío.

⚠️ NOMBRES DE LANES — REGLA CRÍTICA:
  Cada lane en todo el JSON debe tener un nombre ÚNICO en todo el documento.
  Usa el nombre del actor/rol como sufijo si hay ambigüedad:
  "Inicio de sesión Ciudadano", "Inicio de sesión Brigadista"
  "Cerrar sesión Ciudadano", "Cerrar sesión Brigadista"

LANE DE CIERRE — reglas especiales:
  • Máximo 2-3 nodos: intermediateEvent + 1 tarea + endEventTerminate
  • NUNCA un startEvent en el lane de cierre

SUB-FASES DE MÓDULOS:
  Cuando un módulo describe etapas claramente diferenciadas, cada etapa
  con pasos propios merece su propio lane.

═══════════════════════════════════════════════════════════
REGLA 4 — CANTIDAD DE NODOS POR LANE (LÍMITE ESTRICTO)
═══════════════════════════════════════════════════════════
MÁXIMO ABSOLUTO: 7 nodos por lane. Este límite es INVIOLABLE.
Objetivo ideal: entre 4 y 6 nodos por lane (suficiente para mostrar el proceso completo).

NOTA: El límite de 7 no significa que debas reducir a 3. Un proceso completo
puede necesitar 5-6 nodos y eso es correcto y deseable.

CÓMO RESPETAR EL LÍMITE — consolidar solo cuando sea necesario:

  Patrón FORMULARIO (varios campos del mismo formulario):
    Manual: "ingresar nombre", "ingresar CURP", "ingresar correo"
    Diagrama: UNA tarea "Completar formulario" + annotation con los campos

  Patrón VALIDACIÓN TÉCNICA:
    Manual: "el sistema valida formato, verifica en BD, comprueba duplicados"
    Diagrama: UNA tarea "Validar datos"

  Patrón DESCARGA:
    Manual: "el sistema genera el archivo", "el usuario descarga"
    Diagrama: UNA tarea "Generar y descargar documento"

═══════════════════════════════════════════════════════════
REGLA 5 — FLUJO ENTRE SECCIONES Y CONECTIVIDAD OBLIGATORIA
═══════════════════════════════════════════════════════════

REGLA FUNDAMENTAL — Todos los nodos deben estar conectados:
  • Todo nodo DEBE tener al menos 1 entrada (excepto startEvent).
  • Todo nodo DEBE tener al menos 1 salida (excepto endEvent y variantes).
  • Un nodo sin entrada es un nodo HUÉRFANO → diagrama roto en Bizagi.

CÓMO CONECTAR LANES CORRECTAMENTE:
  El último nodo activo del lane A apunta al intermediateEvent que inicia el lane B.
  El intermediateEvent del lane B apunta a la primera tarea del lane B.

MENÚ QUE DISTRIBUYE A VARIOS MÓDULOS:
  intermediateEventMultiple → "next": ["Evt_ModA", "Evt_ModB", ..., "Evt_CerrarSesion"]

REGLA ANTI-BUCLE:
  Los bucles/reintentos se modelan con endEvent descriptivo, no con flechas de regreso.

VERIFICACIÓN antes de escribir el JSON:
  □ ¿Cada step (no startEvent) aparece en el "next" de algún otro nodo?
  □ ¿Todos los endEvent tienen "next": []?
  □ ¿Ningún nodo apunta a un nodo de otro pool?
  □ ¿Hay ciclos A→B→A? → romper con endEvent.

═══════════════════════════════════════════════════════════
REGLA 6 — NO INVENTAR
═══════════════════════════════════════════════════════════
Solo modela lo que el manual describe explícitamente.
  ❌ Tareas, lanes o roles no mencionados en el manual — PROHIBIDO
  ❌ Campos en "annotation" que el manual no menciona — PROHIBIDO

═══════════════════════════════════════════════════════════
REGLA 7 — REGLAS TÉCNICAS Y TIPOS DE NODO
═══════════════════════════════════════════════════════════
• Un startEvent por tipo de usuario, en su primer lane.
• IDs únicos sin espacios: Start_Xxx  Task_Xxx  GW_Xxx  Evt_Xxx  End_Xxx
• Sin referencias circulares.
• exclusiveGateway con más de una salida → campo "conditions" obligatorio.
• steps[] en orden de flujo: startEvent primero.

TIPOS DE NODO:
  startEvent         → Inicio del proceso (círculo verde). Máximo 3 palabras.
  endEvent           → Fin simple (errores, cancelaciones). "next": [] siempre.
  endEventMessage    → Fin con notificación visible al usuario. "next": [] siempre.
  endEventTerminate  → Fin de cierre de sesión ÚNICAMENTE. "next": [] siempre.
  endEventSignal     → Fin que impacta sistema externo. "next": [] siempre.
  userTask           → Acción del usuario en pantalla. Puede llevar "annotation".
  serviceTask        → Llamada automática a API/sistema externo.
  scriptTask         → Validación o proceso interno del sistema.
  exclusiveGateway   → Decisión. Nombre en pregunta. "conditions" obligatorio.
  intermediateEvent  → Conector entre lanes. Exactamente 1 entrada y 1 salida.
  intermediateEventMessage → Notificación dentro del flujo (el flujo continúa).
  intermediateEventMultiple → Hub del menú principal. 1 por pool.

═══════════════════════════════════════════════════════════
REGLA 8 — MANUALES GRANDES (MÁS DE 5 MÓDULOS)
═══════════════════════════════════════════════════════════
1. ABSTRAE, NO COPIES — captura lo distintivo de cada módulo.
2. CUENTA NODOS antes de escribir.
3. PASOS ADMINISTRATIVOS ESTÁNDAR → un solo nodo consolidado.
4. LO QUE SÍ VALE SEPARAR: gateways con rutas distintas, personas distintas,
   documentos de salida, notificaciones externas.

═══════════════════════════════════════════════════════════
REGLA 9 — JSON COMPACTO (OBLIGATORIO)
═══════════════════════════════════════════════════════════
Escribe cada step en UNA SOLA LÍNEA. Reduce el tamaño del JSON un 35-40%.

  ✅ CORRECTO:
  {"id":"Task_Login","name":"Ingresar credenciales","type":"userTask","role":"Inicio de sesión Ciudadano","next":["Script_Val"],"annotation":"Usuario · Contraseña"}

  ❌ INCORRECTO — múltiples líneas por step.

═══════════════════════════════════════════════════════════
REGLA 10 — CHECKLIST FINAL ANTES DE CERRAR EL JSON
═══════════════════════════════════════════════════════════
□ ¿Cada pool tiene exactamente 1 startEvent?
□ ¿Todos los endEvent tienen "next": []?
□ ¿Cada intermediateEvent aparece en el "next" de al menos 1 nodo anterior?
□ ¿Hay algún nodo (no startEvent) cuyo id NO aparece en ningún "next"?
□ ¿Algún nodo no-endEvent tiene "next": [] o vacío?
□ ¿Algún nodo apunta a un nodo de un pool diferente?
□ ¿Algún exclusiveGateway tiene solo 1 salida?
□ ¿Existe algún ciclo A→B→A?
□ ¿Los roles de los lanes reflejan exactamente los roles del manual?
□ ¿Las anotaciones ("annotation") solo contienen campos mencionados en el manual?
□ ¿Los procesos de cada módulo están completos (no resumidos en exceso)?

Solo cuando todos estén verificados, escribir [JSON_END].

═══════════════════════════════════════════════════════════
EJEMPLO COMPLETO — un pool, múltiples roles con anotaciones
═══════════════════════════════════════════════════════════

Sistema con 2 roles: Ciudadano y Brigadista. Son apps distintas → 2 pools.
Dentro de la Herramienta Brigadista hay 3 sub-roles: Brigadista, Director, Coordinador
→ 1 solo pool "Herramienta Brigadista" con anotaciones de rol por lane.

Pool "Portal Ciudadano" — un solo rol → sin anotaciones de rol:
  Lane "Inicio de sesión":
    Start → userTask("Ingresar credenciales") [annotation: "CURP · Contraseña"]
          → scriptTask("Validar acceso") → GW("¿Acceso correcto?")
          → [No] End("Acceso fallido")
          → [Sí] userTask("Acceso a ventana principal") → Menú principal

  Lane "Mis dependientes":
    Evt → userTask("Acceder a mis dependientes")
        → userTask("Buscar por CURP") [annotation: "CURP dependiente"]
        → GW("¿CURP registrada?") → [Sí] End("CURP ya registrada")
                                  → [No] userTask("Completar datos") [annotation: "Nombre · Parentesco · Fecha nacimiento"]
                                       → endEventMessage("Dependiente registrado")

Pool "Herramienta Brigadista" — 3 sub-roles → anotaciones de rol en cada lane:
  Lane "Inicio de sesión":
    Start → userTask("Ingresar credenciales")
            [annotation: "Brigadista · Director de Área · Coordinador Estatal | Usuario · Contraseña"]
          → scriptTask("Validar acceso") → GW → Menú principal

  Lane "Gestión de usuarios":         ← accesible por Brigadista únicamente
    Evt [annotation: "Rol: Brigadista"]
      → userTask("Buscar usuario") [annotation: "CURP · Nombre"]
      → userTask("Crear o editar usuario") [annotation: "Nombre · CURP · Región"]
      → endEventMessage("Usuario guardado")

  Lane "Aprobar solicitudes":         ← accesible por Director y Coordinador
    Evt [annotation: "Rol: Director de Área · Coordinador Estatal"]
      → userTask("Consultar solicitudes pendientes")
      → userTask("Revisar y aprobar") → endEventMessage("Solicitud aprobada")

  Lane "Cerrar sesión":
    Evt → userTask("Confirmar cierre") → endEventTerminate("Sesión cerrada")

[MD_START]
**Sistema analizado:** nombre del sistema
**Roles identificados:** lista de roles EXACTOS del manual
**Lanes:** lista completa en orden
**Pasos totales:** número
**Flujo general:** 2-3 líneas resumiendo el proceso
[MD_END]
[JSON_START]
{
  "pools": [
    { "name": "Nombre Exacto del Sistema - Rol del Manual", "roles": ["Inicio de sesión RolReal", "Módulo A", "Cerrar sesión RolReal"] }
  ],
  "steps": [
    {"id":"Start_A","name":"Inicio de sesión","type":"startEvent","role":"Inicio de sesión RolReal","next":["Task_Cred"]},
    {"id":"Task_Cred","name":"Ingresar credenciales","type":"userTask","role":"Inicio de sesión RolReal","next":["Script_Val"],"annotation":"Usuario · Contraseña"},
    {"id":"Script_Val","name":"Validar acceso","type":"scriptTask","role":"Inicio de sesión RolReal","next":["GW_Login"]},
    {"id":"GW_Login","name":"¿Acceso correcto?","type":"exclusiveGateway","role":"Inicio de sesión RolReal","next":["End_Fallo","Task_Menu"],"conditions":{"End_Fallo":"No","Task_Menu":"Sí"}},
    {"id":"End_Fallo","name":"Acceso fallido","type":"endEvent","role":"Inicio de sesión RolReal","next":[]},
    {"id":"Task_Menu","name":"Acceso a ventana principal","type":"userTask","role":"Inicio de sesión RolReal","next":["Evt_Modulos"]},
    {"id":"Evt_Modulos","name":"Menú principal","type":"intermediateEventMultiple","role":"Inicio de sesión RolReal","next":["Evt_ModA","Evt_Cerrar"]},
    {"id":"Evt_ModA","name":"Módulo A","type":"intermediateEvent","role":"Módulo A","next":["Task_AccederA"]},
    {"id":"Task_AccederA","name":"Acceder a módulo A","type":"userTask","role":"Módulo A","next":["Task_BuscarA"]},
    {"id":"Task_BuscarA","name":"Buscar por folio","type":"userTask","role":"Módulo A","next":["Task_SeleccionarA"],"annotation":"Folio · Fecha"},
    {"id":"Task_SeleccionarA","name":"Seleccionar registro","type":"userTask","role":"Módulo A","next":["Task_EditarA"]},
    {"id":"Task_EditarA","name":"Completar formulario","type":"userTask","role":"Módulo A","next":["End_ModA"],"annotation":"Campo 1 · Campo 2 · Campo 3"},
    {"id":"End_ModA","name":"Operación completada","type":"endEventMessage","role":"Módulo A","next":[]},
    {"id":"Evt_Cerrar","name":"Cerrar sesión","type":"intermediateEvent","role":"Cerrar sesión RolReal","next":["Task_Cerrar"]},
    {"id":"Task_Cerrar","name":"Confirmar cierre","type":"userTask","role":"Cerrar sesión RolReal","next":["End_Sesion"]},
    {"id":"End_Sesion","name":"Sesión cerrada","type":"endEventTerminate","role":"Cerrar sesión RolReal","next":[]}
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

        // Limpiar el texto: eliminar saltos de línea, tabs y espacios extras, y truncar a un máximo de caracteres para evitar saturar a Gemini.
        const rawText    = pdfData.text.replace(/\s+/g, ' ').trim();
        const manualText = rawText.substring(0, CONFIG.maxPdfChars);
        if (manualText.length < 100) return res.status(400).json({ error: 'El PDF no contiene texto extraíble.' });

        let geminiFileUri = null;
        const USE_FILE_API = req.file.size > 500 * 1024;
        if (USE_FILE_API) {
            try {

                // Subir el PDF a la File API de Gemini para que pueda procesarlo sin saturar el prompt.
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
                    console.error(`⚠️  File API falló (${uploadRes.status}) — texto truncado a ${CONFIG.maxPdfChars} chars.`);
                }
            } catch (e) {
                console.error(`⚠️  File API error: ${e.message} — texto truncado a ${CONFIG.maxPdfChars} chars.`);
            }
        }

        /*
        Si el PDF es pequeño o la File API falla, se envía el texto completo (o truncado) en el prompt. 
        Gemini puede manejar hasta 100k chars, pero se recomienda mantenerlo por debajo de 50k para evitar saturación.
        */
        console.log(`PDF: ${req.file.size} bytes, ${pdfData.numpages} pág.`);
        const t0 = Date.now();

        const model = genAI.getGenerativeModel({
            model: CONFIG.model,
            generationConfig: { temperature: CONFIG.temperature, maxOutputTokens: CONFIG.maxTokens },
        });

        // Función para llamar a Gemini con reintentos exponenciales en caso de errores 503 o 429.
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

        // Construir el prompt con el manual y las instrucciones, y llamar a Gemini.
        const raw = await callGemini(buildPrompt(manualText));
        console.log(`Gemini respondió en ${((Date.now() - t0)/1000).toFixed(1)}s`);

        const mdMatch   = raw.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);
        const jsonMatch = raw.match(/\[JSON_START\]([\s\S]*?)\[JSON_END\]/);
        let rawJson = jsonMatch ? jsonMatch[1] : null;

        if (!rawJson) {
            const partial = raw.match(/\[JSON_START\]([\s\S]*)/);
            if (partial) {
                console.warn('Respuesta truncada — solicitando continuación a Gemini...');
                const partialJson = partial[1].trim();
                const continuationPrompt = `El JSON anterior fue cortado por límite de tokens. Continúa EXACTAMENTE desde donde se cortó, sin repetir nada de lo anterior. Escribe SOLO la continuación del JSON (el fragmento que falta) y termina con [JSON_END].

JSON parcial hasta donde llegaste:
${partialJson}

Continúa a partir de aquí:`;
                try {
                    const raw2 = await callGemini(continuationPrompt);
                    console.log(`Continuación recibida (${raw2.length} chars)`);
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

        // Limpiar el JSON de código innecesario, comentarios y comas finales, y parsear.
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

        // FIX 1: Normalizar roles que aparecen en múltiples pools (caso común en manuales con muchos roles y pocos módulos, donde cada pool reclama un rol genérico como "Usuario").
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

        // FIX 0: DIVIDIR lanes con más de 7 nodos en sub-lanes conectados por intermediateEvents puente (bridges).
        {
            const MAX_LANE_NODES = 7;
            const bridgeIds = new Set();
            const isEndType0 = t => ['endEvent','endEventMessage','endEventTerminate','endEventSignal'].includes(t);

            // Divide en grupos de máx maxSize, sin cortar justo en un gateway
            const splitSmart = (arr, maxSize) => {
                if (arr.length <= maxSize) return [arr];
                const groups = [];
                let i = 0;
                while (i < arr.length) {
                    let end = Math.min(i + maxSize, arr.length);
                    // Retroceder si el último del grupo es gateway y aún hay más
                    if (end < arr.length && arr[end - 1]?.type?.includes('Gateway')) end--;
                    if (end <= i) end = i + 1; // garantizar avance mínimo
                    groups.push(arr.slice(i, end));
                    i = end;
                }
                return groups;
            };

            let pass = 0;
            let anyChanged = true;
            while (anyChanged && pass < 20) {
                anyChanged = false; pass++;
                // dedup
                { const seen = new Set(); structure.steps = structure.steps.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; }); }

                const newRoles = [], newSteps = [];
                structure.roles.forEach((role, roleIdx) => {
                    const laneSteps = structure.steps.filter(s => s.role === role);
                    const realCount = laneSteps.filter(s => !bridgeIds.has(s.id)).length;
                    if (realCount <= MAX_LANE_NODES) {
                        newRoles.push(role); laneSteps.forEach(s => newSteps.push(s)); return;
                    }

                    anyChanged = true;
                    const base    = role.replace(/\s*-\s*Parte\s*[\d.]+$/i, '').trim();
                    const safeBase = base.replace(/[^a-zA-Z0-9]/g, '').substring(0, 14);

                    const realSteps   = laneSteps.filter(s => !bridgeIds.has(s.id));
                    const bridgeSteps = laneSteps.filter(s =>  bridgeIds.has(s.id));
                    const groups      = splitSmart(realSteps, MAX_LANE_NODES);
                    const partNames   = groups.map((_, gi) => `${base} - Parte ${roleIdx}.${gi + 1}`);

                    // Reasignar roles a cada grupo
                    groups.forEach((grp, gi) => grp.forEach(s => { s.role = partNames[gi]; }));

                    // Crear bridges entre grupos consecutivos
                    const newBridges = [];
                    for (let gi = 0; gi < groups.length - 1; gi++) {
                        const grp     = groups[gi];
                        const nextGrp = groups[gi + 1];
                        const bid     = `EvtBr_${safeBase}_${pass}_${gi}`;
                        const firstReal = nextGrp.find(s => !isEndType0(s.type));
                        if (!firstReal) continue;

                        bridgeIds.add(bid);
                        newBridges.push({
                            afterGroup: gi,
                            bridge: { id: bid, name: `Continuar ${base.split(' ').slice(-2).join(' ')}`, type: 'intermediateEvent', role: partNames[gi + 1], next: [firstReal.id] }
                        });

                        const lastActive = [...grp].reverse().find(s => !isEndType0(s.type));
                        if (lastActive) {
                            if (!(lastActive.next || []).includes(bid))
                                lastActive.next = [...(lastActive.next || []), bid];
                            // Quitar conexiones directas al siguiente grupo (pasan por el bridge)
                            lastActive.next = lastActive.next.filter(nid =>
                                nid === bid || !nextGrp.some(s => s.id === nid)
                            );
                        }
                    }

                    bridgeSteps.forEach(s => { s.role = partNames[0]; });
                    partNames.forEach((pn, gi) => {
                        newRoles.push(pn);
                        if (gi === 0) bridgeSteps.forEach(s => newSteps.push(s));
                        groups[gi].forEach(s => newSteps.push(s));
                        const b = newBridges.find(b => b.afterGroup === gi);
                        if (b) newSteps.push(b.bridge);
                    });

                    console.warn(`FIX0: "${role}" → ${groups.length} partes (${realCount} nodos)`);
                });

                if (anyChanged) {
                    structure.roles = newRoles;
                    structure.steps = newSteps;
                    if (structure.pools?.length) {
                        structure.pools.forEach(pool => {
                            const updated = [];
                            pool.roles.forEach(origRole => {
                                const replacements = newRoles.filter(nr =>
                                    nr === origRole || nr.startsWith(origRole + ' - Parte ')
                                );
                                updated.push(...(replacements.length ? replacements : [origRole]));
                            });
                            pool.roles = [...new Set(updated)];
                        });
                        console.warn('FIX0-pools: actualizado');
                    }
                }
            }
        }

        // FIX 0c: FUSIONAR lanes de "Parte X.N" que solo contienen endEvents
        // Esto ocurre cuando el FIX 0 corta justo antes de un endEvent de rama de error,
        // dejando ese endEvent solo en un lane separado. Se fusiona de vuelta al lane anterior.
        {
            const isEndType = t => ['endEvent','endEventMessage','endEventTerminate','endEventSignal'].includes(t);
            let fusionChanged = true;
            while (fusionChanged) {
                fusionChanged = false;
                const rolesLocal = [...structure.roles];
                for (let ri = 1; ri < rolesLocal.length; ri++) {
                    const role = rolesLocal[ri];
                    const laneSteps = structure.steps.filter(s => s.role === role);
                    // Solo fusionar si TODOS los steps del lane son endEvents (ninguna tarea real)
                    const allEnds = laneSteps.length > 0 && laneSteps.every(s => isEndType(s.type));
                    if (!allEnds) continue;
                    // Buscar el lane anterior (Parte X.N-1) — debe ser un split del mismo módulo
                    const prevRole = rolesLocal[ri - 1];
                    const baseMatch = role.match(/^(.+)\s*-\s*Parte\s+[\d.]+$/i);
                    const prevMatch = prevRole.match(/^(.+)\s*-\s*Parte\s+[\d.]+$/i);
                    const sameBase = baseMatch && prevMatch &&
                        baseMatch[1].trim() === prevMatch[1].trim();
                    if (!sameBase) continue;
                    // Fusionar: mover los endEvents al lane anterior
                    laneSteps.forEach(s => { s.role = prevRole; });
                    structure.roles = structure.roles.filter(r => r !== role);
                    if (structure.pools?.length) {
                        structure.pools.forEach(pool => {
                            pool.roles = pool.roles.filter(r => r !== role);
                        });
                    }
                    console.warn(`FIX0c: fusionado "${role}" → "${prevRole}" (solo endEvents)`);
                    fusionChanged = true;
                    break; // Reiniciar el while con la lista actualizada
                }
            }
        }

        // FIX 0b: ELIMINAR lanes vacíos (sin ningún step asignado)
        {
            const rolesConSteps = new Set(structure.steps.map(s => s.role));
            const rolesFiltrados = structure.roles.filter(r => rolesConSteps.has(r));
            const eliminados = structure.roles.filter(r => !rolesConSteps.has(r));
            if (eliminados.length) {
                console.warn(`FIX0b: ${eliminados.length} lane(s) vacíos eliminados: ${eliminados.join(', ')}`);
                structure.roles = rolesFiltrados;
                if (structure.pools?.length) {
                    structure.pools.forEach(pool => {
                        pool.roles = (pool.roles || []).filter(r => rolesConSteps.has(r));
                    });
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
            step.next = (step.next || []).filter(nid => {
                if (!validIds.has(nid)) { console.warn(`FIX2: ${step.id}→${nid} eliminado`); return false; }
                return true;
            });
        });

        // FIX 3: roles desconocidos
        structure.steps.forEach(step => {
            if (!structure.roles.includes(step.role)) {
                console.warn(`FIX3: rol desconocido "${step.role}"`);
                step.role = structure.roles[0];
            }
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
            const hub = structure.steps.find(s => s.type === 'intermediateEventMultiple');
            structure.roles.forEach((role, ri) => {
                if (ri === 0) return;
                const laneSteps = structure.steps.filter(s => s.role === role);
                if (!laneSteps.length) return;
                const currentTargets = new Set(structure.steps.flatMap(s => s.next || []));
                const isEndType = t => t === 'endEvent' || t === 'endEventMessage' ||
                                       t === 'endEventTerminate' || t === 'endEventSignal';
                const orphans = laneSteps.filter(s =>
                    !currentTargets.has(s.id) && !isEndType(s.type)
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

        // FIX 7: pasos con múltiples roles (asignar al rol más frecuente, o al primero si hay empate)
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


            // Combinar todas las partes de DI (shapes y edges) en una sola sección de BPMNDiagram.
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

// Iniciar el servidor en el puerto 4000 y configurar los timeouts para evitar desconexiones prematuras durante análisis largos.
const server = app.listen(4000, () => console.log(`Servidor IA en puerto 4000 — modelo: ${CONFIG.model}`));
server.timeout = CONFIG.timeout;
server.keepAliveTimeout = CONFIG.timeout;
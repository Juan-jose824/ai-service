require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const pdf     = require('pdf-parse');
const cors    = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// OpenClaw y detección de procesos (opcionales — si no existen, se omiten sin error)
let analyzeManual = null;
let detectBusinessProcesses = null;
try { ({ analyzeManual } = require('./openclaw/client')); } catch(_) {}
try { ({ detectBusinessProcesses } = require('./services/processDetection')); } catch(_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: '150mb' }));

const upload = multer({ storage: multer.memoryStorage() });
const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CONFIG = {
    model:       'gemini-2.5-flash',
    maxPdfChars: 50_000,
    maxTokens:   65_536,
    temperature: 0,
    timeout:     120_000,
};

// ============================================================
// UTILIDAD: Escapar caracteres especiales XML
// ============================================================
function xmlEscape(str) {
    return (str || '')
        .replace(/&/g,  '&amp;')
        .replace(/</g,  '&lt;')
        .replace(/>/g,  '&gt;')
        .replace(/"/g,  '&quot;')
        .replace(/'/g,  '&apos;');
}

// ============================================================
// 1. ASIGNACIÓN DE COLUMNAS — orden topológico seguro
//    Usa Kahn's algorithm (BFS sin ciclos).
//    Si hay ciclos, los nodos restantes se asignan al final.
// ============================================================
function assignColumns(steps) {
    const stepMap    = {};
    const nodeColumn = {};
    steps.forEach(s => { stepMap[s.id] = s; });

    // Calcular in-degree de cada nodo
    const inDegree = {};
    steps.forEach(s => { inDegree[s.id] = 0; });
    steps.forEach(s => {
        (s.next || []).forEach(nextId => {
            if (inDegree[nextId] !== undefined) inDegree[nextId]++;
        });
    });

    // Iniciar con nodos sin incoming (in-degree 0)
    const queue = steps.filter(s => inDegree[s.id] === 0).map(s => s.id);
    if (queue.length === 0 && steps.length > 0) queue.push(steps[0].id);

    // Procesar en orden topológico — cada nodo se visita UNA sola vez
    const processed = new Set();
    steps.forEach(s => { nodeColumn[s.id] = 0; }); // inicializar a 0

    while (queue.length > 0) {
        const id = queue.shift();
        if (processed.has(id)) continue;
        processed.add(id);

        const step = stepMap[id];
        if (step && step.next) {
            step.next.forEach(nextId => {
                if (!nextId || nextId === id) return;
                // La columna del siguiente es máximo entre su actual y col+1
                const newCol = (nodeColumn[id] || 0) + 1;
                if (newCol > (nodeColumn[nextId] || 0)) {
                    nodeColumn[nextId] = newCol;
                }
                // Solo encolar si no fue procesado (evita ciclos)
                if (!processed.has(nextId)) {
                    queue.push(nextId);
                }
            });
        }
    }

    return nodeColumn;
}

// ============================================================
// 2. ASIGNACIÓN DE FILAS dentro de cada lane
//    Nodos en la misma columna y mismo lane se apilan
//    verticalmente para evitar solapamientos.
// ============================================================
function assignRows(steps, nodeColumn, roles) {
    // Por cada (lane, columna) contar cuántos nodos hay
    const laneColCount = {}; // "roleIndex_col" -> nextRow
    const nodeRow = {};

    // Ordenar steps por columna para asignación consistente
    const sorted = [...steps].sort((a, b) =>
        (nodeColumn[a.id] || 0) - (nodeColumn[b.id] || 0)
    );

    sorted.forEach(step => {
        const roleIdx = roles.indexOf(step.role);
        const col     = nodeColumn[step.id] || 0;
        const key     = `${roleIdx}_${col}`;
        if (laneColCount[key] === undefined) laneColCount[key] = 0;
        nodeRow[step.id] = laneColCount[key];
        laneColCount[key]++;
    });

    // Calcular altura máxima de filas por lane
    const maxRowPerLane = {};
    roles.forEach((_, i) => { maxRowPerLane[i] = 0; });
    steps.forEach(step => {
        const roleIdx = roles.indexOf(step.role);
        const row     = nodeRow[step.id] || 0;
        if (row + 1 > maxRowPerLane[roleIdx]) maxRowPerLane[roleIdx] = row + 1;
    });

    return { nodeRow, maxRowPerLane };
}

// ============================================================
// 3. GENERADOR DE LÓGICA BPMN (XML semántico)
//    Soporta: startEvent, endEvent, endEventMessage,
//             userTask, serviceTask, scriptTask,
//             exclusiveGateway,
//             intermediateEvent, intermediateEventMessage
// ============================================================
function generateLogic(structure, processId, lanePrefix = '') {
    const { roles, steps } = structure;

    const lanes = roles.map((role, idx) => {
        const laneId = `Lane_${lanePrefix}${idx}`;
        const refs = steps
            .filter(s => s.role === role)
            .map(s => `        <flowNodeRef>${s.id}</flowNodeRef>`)
            .join('\n');
        return `      <lane id="${laneId}" name="${xmlEscape(role)}">\n${refs}\n      </lane>`;
    }).join('\n');

    const elements = steps.map(step => {
        const outgoing = (step.next || [])
            .map(t => `      <outgoing>Flow_${step.id}_${t}</outgoing>`)
            .join('\n');
        const incoming = steps
            .filter(s => (s.next || []).includes(step.id))
            .map(s => `      <incoming>Flow_${s.id}_${step.id}</incoming>`)
            .join('\n');

        let xml = '';
        switch (step.type) {
            case 'startEvent':
                xml = `    <startEvent id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </startEvent>`;
                break;
            case 'endEvent':
                xml = `    <endEvent id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </endEvent>`;
                break;
            // EndEvent con señal de mensaje (sobre relleno) — para confirmar operaciones
            case 'endEventMessage':
                xml = `    <endEvent id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n      <messageEventDefinition/>\n    </endEvent>`;
                break;
            case 'exclusiveGateway':
                xml = `    <exclusiveGateway id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </exclusiveGateway>`;
                break;
            case 'userTask':
                xml = `    <userTask id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </userTask>`;
                break;
            case 'serviceTask':
                xml = `    <serviceTask id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </serviceTask>`;
                break;
            // Tarea de sistema/script (engranaje) — para validaciones y guardados
            case 'scriptTask':
                xml = `    <scriptTask id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </scriptTask>`;
                break;
            // Evento intermedio simple (círculo doble) — para marcar inicio de sub-sección/módulo
            case 'intermediateEvent':
                xml = `    <intermediateCatchEvent id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </intermediateCatchEvent>`;
                break;
            // Evento intermedio con mensaje — para notificaciones dentro del proceso
            case 'intermediateEventMessage':
                xml = `    <intermediateThrowEvent id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n      <messageEventDefinition/>\n    </intermediateThrowEvent>`;
                break;
            default:
                xml = `    <task id="${step.id}" name="${xmlEscape(step.name)}">\n${incoming}\n${outgoing}\n    </task>`;
        }
        return xml;
    }).join('\n');

    const sequences = steps.flatMap(step =>
        (step.next || []).map(targetId => {
            const condAttr = step.conditions?.[targetId]
                ? ` name="${xmlEscape(step.conditions[targetId])}"`
                : '';
            return `    <sequenceFlow id="Flow_${step.id}_${targetId}" sourceRef="${step.id}" targetRef="${targetId}"${condAttr}/>`;
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

// ============================================================
// 4. GENERADOR DE LAYOUT (BPMN DI)
//
//  ESTRATEGIA: COLUMNAS LOCALES POR LANE
//  ─────────────────────────────────────
//  • Cada lane calcula su propio orden topológico interno.
//  • Los nodos del lane se colocan col 0, 1, 2... de izquierda a derecha
//    SIEMPRE empezando en el borde izquierdo del pool.
//  • Si un lane tiene más de MAX_PER_ROW nodos, se divide en filas.
//  • Las conexiones CROSS-LANE salen por el borde derecho del nodo origen
//    y bajan/suben verticalmente hasta el lane destino, entrando por la izq.
//  • Esto elimina el problema de nodos "empujados" lejos a la derecha
//    por el algoritmo global.
// ============================================================
function generateDI(structure, processId, poolOpts = {}) {
    const { roles, steps } = structure;
    const POOL_ID   = poolOpts.poolId   ?? 'Participant_1';
    const POOL_NAME = poolOpts.poolName ?? 'Proceso de Negocio';
    const POOL_Y    = poolOpts.poolY    ?? 60;
    const LANE_PFX  = POOL_ID === 'Participant_1' ? '' : 'B';
    const COLLAB_ID = POOL_ID === 'Participant_1' ? 'Collaboration_1' : 'Collaboration_2';
    const DIAG_ID   = POOL_ID === 'Participant_1' ? 'BPMNDiagram_1'   : 'BPMNDiagram_2';

    // ── Node dimensions ────────────────────────────────────────
    const NODE_SIZE = {
        startEvent:               { w: 36,  h: 36 },
        endEvent:                 { w: 36,  h: 36 },
        endEventMessage:          { w: 36,  h: 36 },
        exclusiveGateway:         { w: 50,  h: 50 },
        parallelGateway:          { w: 50,  h: 50 },
        task:                     { w: 120, h: 80 },
        userTask:                 { w: 120, h: 80 },
        serviceTask:              { w: 120, h: 80 },
        scriptTask:               { w: 120, h: 80 },
        intermediateEvent:        { w: 36,  h: 36 },
        intermediateEventMessage: { w: 36,  h: 36 },
    };
    const sz = type => NODE_SIZE[type] || NODE_SIZE.task;

    // ── Layout constants ──────────────────────────────────────
    const POOL_X    = 160;
    const LABEL_W   = 30;          // pool/lane label strip width
    const LANE_X    = POOL_X + LABEL_W;
    const COL_W     = 260;         // horizontal gap between node centres
    const ROW_H     = 200;         // vertical gap between row centres (within a lane)
    const V_PAD     = 80;          // top/bottom padding inside each lane row
    const START_CX  = LANE_X + 90; // centre-x of column 0
    const MAX_COLS  = 6;           // wrap to new row after this many columns

    const stepMap = {};
    steps.forEach(s => { stepMap[s.id] = s; });

    // ── 1. Topological order within each lane ─────────────────
    const laneOrder = {};
    roles.forEach(role => {
        const members = new Set(steps.filter(s => s.role === role).map(s => s.id));
        const inDeg   = {};
        members.forEach(id => { inDeg[id] = 0; });
        members.forEach(id => {
            (stepMap[id]?.next || []).forEach(nid => {
                if (members.has(nid)) inDeg[nid]++;
            });
        });
        const queue = [...members].filter(id => inDeg[id] === 0);
        if (!queue.length && members.size) queue.push([...members][0]);
        const order = [], seen = new Set();
        while (queue.length) {
            const id = queue.shift();
            if (seen.has(id)) continue;
            seen.add(id); order.push(id);
            (stepMap[id]?.next || []).forEach(nid => {
                if (members.has(nid) && !seen.has(nid)) queue.push(nid);
            });
        }
        steps.filter(s => members.has(s.id) && !seen.has(s.id))
             .forEach(s => order.push(s.id));
        laneOrder[role] = order;
    });

    // ── 2. Assign col/row within each lane ────────────────────
    // Single row when n <= MAX_COLS, wrap when > MAX_COLS.
    const nodeCol = {}, nodeRow = {};
    const laneRows = {};   // role → number of rows used

    roles.forEach(role => {
        const order = laneOrder[role] || [];
        let rowCount = 0;
        order.forEach((id, idx) => {
            nodeCol[id] = idx % MAX_COLS;
            nodeRow[id] = Math.floor(idx / MAX_COLS);
            rowCount = Math.max(rowCount, nodeRow[id] + 1);
        });
        laneRows[role] = Math.max(rowCount, 1);
    });

    // ── 3. Lane heights ───────────────────────────────────────
    const laneH = {};
    roles.forEach((role, ri) => {
        const rows = laneRows[role];
        // Each row needs V_PAD above + ROW_H + V_PAD below.
        // For multi-row: share the middle padding between rows.
        laneH[ri] = V_PAD + rows * ROW_H + (rows - 1) * 20 + V_PAD;
    });

    // ── 4. Lane Y positions ───────────────────────────────────
    const laneY = {};
    let curY = POOL_Y;
    roles.forEach((_, ri) => { laneY[ri] = curY; curY += laneH[ri]; });
    const poolH = curY - POOL_Y;

    // ── 5. Node pixel positions ───────────────────────────────
    const pos = {};
    steps.forEach(s => {
        const { w, h } = sz(s.type);
        const ri  = roles.indexOf(s.role);
        const col = nodeCol[s.id] ?? 0;
        const row = nodeRow[s.id] ?? 0;
        const cx  = START_CX + col * COL_W;
        const rowOffset = row * (ROW_H + 20);
        const cy  = laneY[ri] + V_PAD + ROW_H / 2 + rowOffset;
        pos[s.id] = { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
    });

    // Pool width: cover all nodes + highway margin
    const maxContentX = steps.reduce((m, s) => {
        const p = pos[s.id]; return p ? Math.max(m, p.x + p.w) : m;
    }, 0);

    // ── 6. Cross-lane highway routing ─────────────────────────
    //
    // DOWN (src lane above tgt): exit node bottom → drop to bottom-pad slot →
    //   slide right to dedicated highway track → drop to tgt top-pad slot →
    //   enter target top.
    //
    // UP (src lane below tgt): exit node top → rise to top-pad slot →
    //   slide right to highway track → rise to tgt bottom-pad slot →
    //   enter target bottom.
    //
    // Highway tracks fan RIGHT from maxContentX, one track per connection,
    // staggered 20 px apart (outermost = longest gap).
    // paddingY for each connection is staggered 24 px per source-rank
    // so condition labels never overlap (label height = 20 px).

    const HW_BASE    = maxContentX + 50;
    const HW_STEP    = 22;   // px between highway tracks
    const PAD_STEP   = 24;   // px between paddingY slots (must be > label height 20)
    const HW_MARGIN  = 500;

    const poolW = Math.max(HW_BASE + 20 * HW_STEP + 80, maxContentX + HW_MARGIN) - POOL_X;

    // Collect and sort cross-lane edges
    const hwMap      = new Map();  // "src→tgt" → hwX
    const downRank   = new Map();  // "src→tgt" → per-source down rank
    const upRank     = new Map();  // "src→tgt" → per-source up rank
    let   hwGlobal   = 0;

    {
        const cross = [];
        steps.forEach(s => {
            const si = roles.indexOf(s.role);
            (s.next || []).forEach(tid => {
                const t = stepMap[tid];
                if (!t) return;
                const ti = roles.indexOf(t.role);
                if (ti === si) return;
                cross.push({ src: s.id, tgt: tid, si, ti,
                             gap: Math.abs(ti - si),
                             dir: ti > si ? 'down' : 'up',
                             col: nodeCol[s.id] ?? 0 });
            });
        });
        cross.sort((a, b) =>
            a.si - b.si ||
            (a.dir === 'down' ? 0 : 1) - (b.dir === 'down' ? 0 : 1) ||
            a.gap - b.gap ||
            a.col - b.col
        );

        const dCnt = new Map(), uCnt = new Map();
        cross.forEach(e => {
            const key = `${e.src}->${e.tgt}`;
            hwMap.set(key, HW_BASE + hwGlobal * HW_STEP);
            hwGlobal++;
            if (e.dir === 'down') {
                const c = dCnt.get(e.src) || 0;
                downRank.set(key, c); dCnt.set(e.src, c + 1);
            } else {
                const c = uCnt.get(e.src) || 0;
                upRank.set(key, c); uCnt.set(e.src, c + 1);
            }
        });
    }

    // ── Helpers ───────────────────────────────────────────────
    const P   = id => pos[id];
    const R   = id => P(id).x + P(id).w;
    const L   = id => P(id).x;
    const T   = id => P(id).y;
    const B   = id => P(id).y + P(id).h;
    const CX  = id => P(id).cx;
    const CY  = id => P(id).cy;
    const wpt = pts => pts.map(([x, y]) =>
        `        <di:waypoint x="${Math.round(x)}" y="${Math.round(y)}"/>`).join('\n');

    // ── 7. Build shapes XML ───────────────────────────────────
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
        shapes += `      <bpmndi:BPMNShape id="Shape_${s.id}" bpmnElement="${s.id}">
        <dc:Bounds x="${Math.round(p.x)}" y="${Math.round(p.y)}" width="${p.w}" height="${p.h}"/>
      </bpmndi:BPMNShape>\n`;
    });

    // ── 8. Build edges XML ────────────────────────────────────
    let edges = '';

    steps.forEach(step => {
        if (!P(step.id)) return;
        const srcRi  = roles.indexOf(step.role);
        const srcRow = nodeRow[step.id] ?? 0;

        (step.next || []).forEach(targetId => {
            if (!P(targetId)) return;
            const tgtRi  = roles.indexOf(stepMap[targetId]?.role);
            const tgtRow = nodeRow[targetId] ?? 0;
            const edgeId = `Edge_${step.id}_${targetId}`;
            const flowId = `Flow_${step.id}_${targetId}`;

            const x1 = R(step.id),  y1 = CY(step.id);
            const x2 = L(targetId), y2 = CY(targetId);

            let pts;

            if (srcRi === tgtRi) {
                // ── Same lane ─────────────────────────────────
                const lTop  = laneY[srcRi];
                const lPad  = V_PAD;

                if (srcRow < tgtRow) {
                    // Forward wrap: right edge → down → re-enter col 0
                    const wrapX = START_CX + (MAX_COLS - 1) * COL_W + 80;
                    const midY  = laneY[srcRi] + V_PAD + (srcRow + 1) * (ROW_H + 20);
                    pts = [
                        [x1, y1], [wrapX, y1], [wrapX, midY],
                        [START_CX - 50, midY], [START_CX - 50, y2], [x2, y2],
                    ];
                } else if (srcRow === tgtRow && x2 < x1) {
                    // Backward arc: above lane in top padding
                    const arcY = lTop + 12;
                    pts = [
                        [x1, y1], [x1 + 12, y1], [x1 + 12, arcY],
                        [x2 - 12, arcY], [x2 - 12, y2], [x2, y2],
                    ];
                } else {
                    // Simple forward, same row
                    pts = [[x1, y1], [x2, y2]];
                }

            } else {
                // ── Cross-lane highway ────────────────────────
                const key  = `${step.id}->${targetId}`;
                const hwX  = hwMap.get(key) ?? HW_BASE;

                if (srcRi < tgtRi) {
                    // Going DOWN
                    const rank    = downRank.get(key) ?? 0;
                    const padBase = laneY[srcRi] + laneH[srcRi] - Math.round(V_PAD / 2);
                    const padY    = padBase - rank * PAD_STEP;
                    const tPadY   = laneY[tgtRi] + Math.round(V_PAD / 2);
                    pts = [
                        [CX(step.id), B(step.id)],
                        [CX(step.id), padY],
                        [hwX,         padY],
                        [hwX,         tPadY],
                        [CX(targetId),T(targetId)],
                    ];
                } else {
                    // Going UP
                    const rank    = upRank.get(key) ?? 0;
                    const padBase = laneY[srcRi] + Math.round(V_PAD / 2);
                    const padY    = padBase + rank * PAD_STEP;
                    const tPadY   = laneY[tgtRi] + laneH[tgtRi] - Math.round(V_PAD / 2);
                    pts = [
                        [CX(step.id), T(step.id)],
                        [CX(step.id), padY],
                        [hwX,         padY],
                        [hwX,         tPadY],
                        [CX(targetId),B(targetId)],
                    ];
                }
            }

            // ── Condition label positioning ───────────────────
            // Anchored at (hwX - labelW - 8, padY + 3) for cross-lane flows:
            //   hwX is unique per track → horizontal spread
            //   padY is staggered 24 px → vertical spread (> labelH 20 px)
            //   ⟹ No two labels ever share the same position.
            const condText = step.conditions?.[targetId];
            let labelXml = '';
            if (condText) {
                const labelW = Math.min(condText.length * 7 + 10, 130);
                let lx, ly;
                if (pts.length >= 5) {
                    // Use highway elbow position
                    lx = Math.round(pts[2][0] - labelW - 8);
                    ly = Math.round(pts[1][1] + 3);
                } else if (pts.length >= 3) {
                    lx = Math.round((pts[1][0] + pts[2][0]) / 2 - labelW / 2);
                    ly = Math.round(pts[1][1] + 3);
                } else {
                    lx = Math.round((pts[0][0] + pts[pts.length-1][0]) / 2 - labelW / 2);
                    ly = Math.round((pts[0][1] + pts[pts.length-1][1]) / 2 - 10);
                }
                labelXml = `\n        <bpmndi:BPMNLabel><dc:Bounds x="${lx}" y="${ly}" width="${labelW}" height="20"/></bpmndi:BPMNLabel>`;
            }

            edges += `      <bpmndi:BPMNEdge id="${edgeId}" bpmnElement="${flowId}">${labelXml}
${wpt(pts)}
      </bpmndi:BPMNEdge>\n`;
        });
    });

    return { poolH, shapesXml: shapes, edgesXml: edges };
}


// ============================================================
// 5. PROMPT — pide JSON compacto, máx 50 pasos
// ============================================================
function buildPrompt(text) {
    return `Eres un analista de procesos BPMN experto. Analiza el manual y genera un diagrama BPMN en estilo Bizagi.

TU TAREA: leer el manual COMPLETO y modelar TODOS los procesos descritos, sin omitir ninguna sección.

═══════════════════════════════════════════════════════════
PASO 1 — ANTES DE GENERAR EL JSON: IDENTIFICA EXHAUSTIVAMENTE
═══════════════════════════════════════════════════════════
Lee el manual de principio a fin y lista:
  A) Todos los tipos de usuario (ej: Ciudadano, Brigadista)
  B) Para CADA usuario: TODAS las secciones/módulos descritos
  C) Cada sección → su lane en el diagrama

REGLA DE ORO: si el manual describe una sección, DEBE aparecer como lane.
No omitas ninguna. Si no estás seguro, inclúyela.

═══════════════════════════════════════════════════════════
REGLA 1 — LENGUAJE TÉCNICO OBLIGATORIO
═══════════════════════════════════════════════════════════
Nombres de tareas: QUÉ hace el actor, nunca CÓMO hace clic en la interfaz.
  ❌ "Presionar 'Continuar'"       → ✅ "Confirmar datos del formulario"
  ❌ "Dar clic en 'Cerrar sesión'" → ✅ "Cerrar sesión"
  ❌ "Presionar ícono editar"      → ✅ "Seleccionar registro para editar"
  ❌ Tocar / Pulsar / Presionar    → ✅ Ingresar / Validar / Seleccionar / Confirmar

═══════════════════════════════════════════════════════════
REGLA 2 — ESTRUCTURA DE FLUJO (LEY FUNDAMENTAL)
═══════════════════════════════════════════════════════════
• endEvent / endEventMessage NUNCA tiene "next" con valores. Siempre "next": []
• intermediateEvent SIEMPRE tiene exactamente 1 entrada y 1 salida.
• PROHIBIDO conectar nodos de un usuario (Ciudadano) con nodos de otro (Brigadista).
  Cada tipo de usuario es un flujo completamente independiente. No hay conexiones entre ellos.
• PROHIBIDO que un endEvent apunte a cualquier otro nodo — ni intermediateEvent ni task.

Conectar secciones:
  ✅ última_tarea_lane1 → intermediateEvent_inicio_lane2 → primera_tarea_lane2
  ❌ última_tarea → endEvent → intermediateEvent  (endEvent termina todo, no puede conectar)
  ❌ intermediateEvent sin ningún nodo apuntando a él (queda flotante, inválido)
  ❌ End_SesionCerradaCiudadano → Evt_Brigadista  (cross-pool: ABSOLUTAMENTE PROHIBIDO)

Menú / hub con múltiples módulos:
  ✅ tarea_visualizar_menu → "next": ["Evt_ModA", "Evt_ModB", ..., "Evt_CerrarSesion"]
  Cada Evt_ModX → primera tarea de ese módulo
  Evt_CerrarSesion → tarea cerrar sesión → endEvent

Módulos con sub-ramas (ej: Gestión de usuarios tiene Crear Y Buscar/Editar):
  ✅ Evt_GestionUsuarios → "next": ["Task_CrearUsuario", "Task_BuscarUsuario"]
  Cada rama tiene su propio end event. NO uses intermediateEvents intermedios para esto.

═══════════════════════════════════════════════════════════
REGLA 3 — ESTRUCTURA DE LANES (OBLIGATORIA)
═══════════════════════════════════════════════════════════
Cada lane = UNA sección funcional. Orden fijo para cada tipo de usuario:

  1. Inicio de sesión         ← startEvent va aquí
  2. Pre-registro (si existe) ← dividir en Parte 1 / Parte 2 si > 6 nodos
  3. Recuperación contraseña  ← si el manual lo describe
  4. Verificación de cuenta   ← si el manual lo describe
  5. Menú principal           ← siempre presente
  6. [Un lane por cada módulo listado en el menú]
  7. Cerrar sesión            ← siempre el último

Si hay DOS tipos de usuario → DOS bloques de lanes independientes, cada uno con su startEvent.
NO crear gateway de selección de usuario/portal — son flujos separados.

TODOS los módulos del menú deben tener su propio lane.
Si el menú lista 6 módulos → 6 lanes de módulos. No resumir en uno solo.

═══════════════════════════════════════════════════════════
REGLA 4 — NO INVENTAR
═══════════════════════════════════════════════════════════
Solo incluye lo que el manual describe explícitamente.
  ❌ Gateways de selección de rol/tipo de usuario — PROHIBIDO
  ❌ Lanes o pasos no mencionados en el manual — PROHIBIDO
  En caso de duda: omite el paso. Diagrama incompleto > diagrama con pasos falsos.

═══════════════════════════════════════════════════════════
REGLA 5 — REGLAS TÉCNICAS
═══════════════════════════════════════════════════════════
• UN startEvent por tipo de usuario, siempre en su lane de inicio.
• IDs únicos, sin espacios: Start_Xxx, Task_Xxx, GW_Xxx, Evt_Xxx, End_Xxx
• NUNCA referencias circulares directas: A → B → A
• "conditions" obligatorio en exclusiveGateway con más de una salida.
• Máximo 5 nodos por lane. Si hay más → dividir OBLIGATORIAMENTE en "Sección - Parte 1", "Sección - Parte 2". Nunca más de 5 nodos en un mismo lane. Esta regla es ABSOLUTA.
• steps[] ordenado: startEvent primero, luego nodo por nodo en orden de flujo.

TIPOS DE NODO:
  startEvent               → Inicio del proceso. Solo uno por flujo de usuario.
  endEvent                 → Fin de sección (sin notificación). "next": [] siempre.
  endEventMessage          → Fin con notificación al usuario. "next": [] siempre.
  userTask                 → Acción del usuario: Ingresar, Seleccionar, Confirmar, Revisar...
  serviceTask              → Llamada a sistema externo o API.
  scriptTask               → Validación o procesamiento interno del sistema.
  exclusiveGateway         → Decisión (rombo). Requiere "conditions" con etiqueta por salida.
  intermediateEvent        → Conector entre secciones / inicio de módulo. 1 entrada, 1 salida.
  intermediateEventMessage → Notificación/mensaje en el flujo (email, código, alerta).

═══════════════════════════════════════════════════════════
EJEMPLO DE ESTRUCTURA CORRECTA (estructura, no contenido real)
═══════════════════════════════════════════════════════════
[MD_START]
**Lanes:** lista completa de secciones identificadas
**Pasos totales:** número
**Flujo general:** 2-3 líneas
[MD_END]
[JSON_START]
{
  "roles": ["Inicio de sesión", "Pre-registro", "Verificación de cuenta", "Menú principal", "Módulo A", "Módulo B", "Cerrar sesión"],
  "steps": [
    { "id": "Start_Login", "name": "Iniciar proceso", "type": "startEvent", "role": "Inicio de sesión", "next": ["Task_Credenciales"] },
    { "id": "Task_Credenciales", "name": "Ingresar credenciales de acceso", "type": "userTask", "role": "Inicio de sesión", "next": ["Script_ValidarLogin"] },
    { "id": "Script_ValidarLogin", "name": "Validar credenciales", "type": "scriptTask", "role": "Inicio de sesión", "next": ["GW_Login"] },
    { "id": "GW_Login", "name": "¿Autenticación exitosa?", "type": "exclusiveGateway", "role": "Inicio de sesión", "next": ["Evt_Menu", "Task_ErrorLogin"], "conditions": {"Evt_Menu": "Sí", "Task_ErrorLogin": "No"} },
    { "id": "Task_ErrorLogin", "name": "Mostrar error de autenticación", "type": "userTask", "role": "Inicio de sesión", "next": ["Task_Credenciales"] },
    { "id": "Evt_PreRegistro", "name": "Iniciar pre-registro", "type": "intermediateEvent", "role": "Pre-registro", "next": ["Task_LlenarFormulario"] },
    { "id": "Task_LlenarFormulario", "name": "Completar formulario de registro", "type": "userTask", "role": "Pre-registro", "next": ["End_PreRegistro"] },
    { "id": "End_PreRegistro", "name": "Pre-registro completado", "type": "endEvent", "role": "Pre-registro", "next": [] },
    { "id": "Evt_Menu", "name": "Acceso al menú principal", "type": "intermediateEvent", "role": "Menú principal", "next": ["Task_VerMenu"] },
    { "id": "Task_VerMenu", "name": "Visualizar opciones del menú", "type": "userTask", "role": "Menú principal", "next": ["Evt_ModuloA", "Evt_ModuloB", "Evt_CerrarSesion"] },
    { "id": "Evt_ModuloA", "name": "Iniciar Módulo A", "type": "intermediateEvent", "role": "Módulo A", "next": ["Task_AccionA"] },
    { "id": "Task_AccionA", "name": "Ejecutar acción del módulo A", "type": "userTask", "role": "Módulo A", "next": ["End_ModuloA"] },
    { "id": "End_ModuloA", "name": "Módulo A completado", "type": "endEventMessage", "role": "Módulo A", "next": [] },
    { "id": "Evt_ModuloB", "name": "Iniciar Módulo B", "type": "intermediateEvent", "role": "Módulo B", "next": ["Task_AccionB"] },
    { "id": "Task_AccionB", "name": "Ejecutar acción del módulo B", "type": "userTask", "role": "Módulo B", "next": ["End_ModuloB"] },
    { "id": "End_ModuloB", "name": "Módulo B completado", "type": "endEventMessage", "role": "Módulo B", "next": [] },
    { "id": "Evt_CerrarSesion", "name": "Iniciar cierre de sesión", "type": "intermediateEvent", "role": "Cerrar sesión", "next": ["Task_ConfirmarCierre"] },
    { "id": "Task_ConfirmarCierre", "name": "Confirmar cierre de sesión", "type": "userTask", "role": "Cerrar sesión", "next": ["End_SesionCerrada"] },
    { "id": "End_SesionCerrada", "name": "Sesión cerrada exitosamente", "type": "endEventMessage", "role": "Cerrar sesión", "next": [] }
  ]
}
[JSON_END]

MANUAL A ANALIZAR:
${text}`;
}
// ============================================================
// 6. ENDPOINT PRINCIPAL
// ============================================================
app.post('/analyze', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Archivo no recibido.' });

        // Extraer texto completo del PDF — sin chunking, sin huecos.
        // Gemini 2.5 Flash tiene ventana de 1M tokens; un manual de 30 páginas
        // es ~5,000 tokens, completamente dentro del límite.
        const pdfData    = await pdf(req.file.buffer);
        const rawText    = pdfData.text.replace(/\s+/g, ' ').trim();
        const manualText = rawText.substring(0, CONFIG.maxPdfChars);

        if (manualText.length < 100) {
            return res.status(400).json({ error: 'El PDF no contiene texto extraíble.' });
        }

        console.log(`PDF extraído: ${manualText.length} chars — llamando a Gemini (${CONFIG.model})...`);
        const t0 = Date.now();

        const model = genAI.getGenerativeModel({
            model: CONFIG.model,
            generationConfig: {
                temperature:     CONFIG.temperature,
                maxOutputTokens: CONFIG.maxTokens,
            },
        });

        // ── OpenClaw: análisis estructural previo (opcional) ─────────────
        let openclawAnalysis = null;
        if (analyzeManual) {
            try {
                console.log('Ejecutando análisis con OpenClaw...');
                openclawAnalysis = await analyzeManual(manualText);
                if (openclawAnalysis) console.log('OpenClaw completó el análisis.');
            } catch(err) {
                console.log('OpenClaw no disponible, continuando con Gemini.');
            }
        }

        // ── Detectar procesos (multi-diagrama) o usar Gemini directo ─────
        async function callGemini(promptText) {
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    console.log(`Llamando a Gemini (intento ${attempt + 1}/4)...`);
                    const r = await model.generateContent(promptText);
                    return r.response.text();
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

        // Construir texto enriquecido con OpenClaw si está disponible
        function enrichText(base, processInfo = null) {
            if (!openclawAnalysis && !processInfo) return base;
            let enriched = '';
            if (openclawAnalysis) {
                enriched += `ANÁLISIS DEL SISTEMA:\n${JSON.stringify(openclawAnalysis, null, 2)}\n\n`;
            }
            if (processInfo) {
                enriched += `PROCESO: ${processInfo.name}\nDESCRIPCIÓN: ${processInfo.description || ''}\nACTORES: ${(processInfo.actors || []).join(', ')}\n\n`;
            }
            enriched += `MANUAL:\n${base}`;
            return enriched;
        }

        // ── Multi-diagrama si detectBusinessProcesses está disponible ─────
        let rawJsonList = [];   // [{raw, name}]

        if (detectBusinessProcesses) {
            const detectedProcesses = await detectBusinessProcesses(manualText);
            console.log(`Procesos detectados: ${detectedProcesses.length}`);

            for (const process of detectedProcesses) {
                console.log(`Generando BPMN para: ${process.name}`);
                try {
                    const raw = await callGemini(buildPrompt(enrichText(manualText, process)));
                    rawJsonList.push({ raw, name: process.name });
                } catch(e) {
                    console.warn(`Diagrama "${process.name}" falló: ${e.message}`);
                }
            }
        }

        // Fallback: llamada única si no hay detectBusinessProcesses o no detectó nada
        if (rawJsonList.length === 0) {
            console.log('Generando diagrama único...');
            const raw = await callGemini(buildPrompt(enrichText(manualText)));
            rawJsonList.push({ raw, name: 'Proceso Principal' });
        }

        // ── Parsear cada respuesta ────────────────────────────────────────
        function extractJson(responseText) {
            const mdMatch   = responseText.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);
            const jsonMatch = responseText.match(/\[JSON_START\]([\s\S]*?)\[JSON_END\]/);
            let rawJson = null;
            if (jsonMatch) {
                rawJson = jsonMatch[1];
            } else {
                const partial = responseText.match(/\[JSON_START\]([\s\S]*)/);
                if (partial) { console.warn('Respuesta truncada — reparando...'); rawJson = partial[1]; }
            }
            return { mdMatch, rawJson };
        }

        const { mdMatch, rawJson: rawJsonFirst } = extractJson(rawJsonList[0].raw);
        let rawJson = rawJsonFirst;

        if (!rawJson) {
            console.error('Sin JSON en respuesta:', rawJsonList[0].raw.substring(0, 300));
            throw new Error('Gemini no devolvió JSON válido. Intenta de nuevo.');
        }

        // Guardar todos los raws para procesar después
        const allRawJsons = rawJsonList.map(({ raw, name }) => {
            const { rawJson } = extractJson(raw);
            return { rawJson, name };
        }).filter(x => x.rawJson);

        console.log(`Gemini respondió en ${((Date.now() - t0) / 1000).toFixed(1)}s — ${rawJsonList.length} diagrama(s)`);

        // Parsear JSON, reparando truncamientos y limpiando comentarios
        let structure;
        try {
            let jsonStr = rawJson.replace(/```json|```/g, '').trim();

            // 1. Eliminar comentarios de línea  (// ...) que Gemini a veces inserta
            jsonStr = jsonStr.replace(/\/\/[^\n\r"]*/g, '');

            // 2. Eliminar comentarios de bloque (/* ... */)
            jsonStr = jsonStr.replace(/\/\*[\s\S]*?\*\//g, '');

            // 3. Eliminar comas sobrantes antes de ] o } (trailing commas)
            jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

            // 4. Cerrar JSON truncado si termina sin '}'
            if (!jsonStr.trimEnd().endsWith('}')) {
                const lastBrace = jsonStr.lastIndexOf('}');
                if (lastBrace > 0) {
                    jsonStr = jsonStr.substring(0, lastBrace + 1) + '\n  ]\n}';
                    console.warn('JSON cerrado automáticamente (estaba truncado).');
                }
            }

            structure = JSON.parse(jsonStr);
        } catch (e) {
            throw new Error(`JSON inválido: ${e.message}`);
        }

        if (!structure.roles?.length || !structure.steps?.length) {
            throw new Error('Respuesta de Gemini sin roles o pasos válidos.');
        }

        // ── Post-procesado: corregir errores comunes del modelo ─────────────
        const stepMap_v = Object.fromEntries(structure.steps.map(s => [s.id, s]));
        const validIds  = new Set(structure.steps.map(s => s.id));

        // FIX 1: endEvent nunca puede tener next[]
        structure.steps.forEach(step => {
            if (step.type?.startsWith('endEvent') && step.next?.length) {
                console.warn(`FIX1: endEvent "${step.id}" tenía next=[${step.next}] — eliminando`);
                step.next = [];
            }
        });

        // FIX 2: eliminar referencias a IDs inexistentes en next[]
        structure.steps.forEach(step => {
            const before = (step.next || []).length;
            step.next = (step.next || []).filter(nid => {
                if (!validIds.has(nid)) {
                    console.warn(`FIX2: "${step.id}" apunta a "${nid}" inexistente — eliminado`);
                    return false;
                }
                return true;
            });
        });

        // FIX 3: roles desconocidos → primer rol
        structure.steps.forEach(step => {
            if (!structure.roles.includes(step.role)) {
                console.warn(`FIX3: rol desconocido "${step.role}" → ${structure.roles[0]}`);
                step.role = structure.roles[0];
            }
        });

        // FIX 4: exclusiveGateway sin salidas → conectar a los 2 siguientes en steps[]
        structure.steps.forEach((step, idx) => {
            if (step.type === 'exclusiveGateway' && !(step.next?.length)) {
                const candidates = [];
                for (let i = idx + 1; i < structure.steps.length && candidates.length < 2; i++) {
                    if (structure.steps[i].role === step.role) candidates.push(structure.steps[i].id);
                }
                if (!candidates.length) {
                    for (let i = idx + 1; i < structure.steps.length && candidates.length < 2; i++) {
                        candidates.push(structure.steps[i].id);
                    }
                }
                if (candidates.length) {
                    step.next = candidates;
                    if (!step.conditions) step.conditions = {};
                    candidates.forEach((id, i) => { if (!step.conditions[id]) step.conditions[id] = i === 0 ? 'Sí' : 'No'; });
                    console.warn(`FIX4: gateway "${step.id}" sin salidas → ${candidates}`);
                }
            }
        });

        // FIX 5: nodos huérfanos (sin incoming) en lanes > 0
        // Solo el startEvent del primer lane puede no tener incoming.
        // Si un intermediateEvent no tiene incoming → conectarlo desde el hub o lane anterior.
        // NUNCA convertir endEvent en userTask — eso crea flujos rotos cross-pool.
        {
            const allTargets = new Set(structure.steps.flatMap(s => s.next || []));
            // Buscar hub de módulos: intermediateEvent con múltiples salidas (menú)
            const hub = structure.steps.find(s =>
                s.type === 'intermediateEvent' && (s.next || []).length > 1
            );
            structure.roles.forEach((role, ri) => {
                if (ri === 0) return; // primer lane: el startEvent no necesita incoming
                const laneSteps = structure.steps.filter(s => s.role === role);
                if (!laneSteps.length) return;
                const first = laneSteps[0];
                if (allTargets.has(first.id)) return; // ya tiene entrada

                // Si el primero es startEvent → convertir a intermediateEvent
                if (first.type === 'startEvent') {
                    first.type = 'intermediateEvent';
                    console.warn(`FIX5: startEvent huérfano "${first.id}" → intermediateEvent`);
                }

                // Intentar conectar desde hub (menú)
                if (hub && !hub.next.includes(first.id) && first.type === 'intermediateEvent') {
                    hub.next.push(first.id);
                    allTargets.add(first.id);
                    console.warn(`FIX5: hub "${hub.id}" → "${first.id}"`);
                    return;
                }

                // Fallback: conectar desde último nodo no-end del lane anterior
                const prevLane = structure.steps.filter(s => s.role === structure.roles[ri - 1]);
                const connector = [...prevLane].reverse().find(s => !s.type?.startsWith('endEvent'));
                if (connector && !connector.next.includes(first.id)) {
                    connector.next.push(first.id);
                    allTargets.add(first.id);
                    console.warn(`FIX5: "${connector.id}" → "${first.id}" (lane ${ri-1}→${ri})`);
                }
            });
        }

        // FIX 6: nodos sin salida (no-end, no-gateway) → conectar al siguiente en el lane
        structure.steps.forEach((step, idx) => {
            if (step.type?.startsWith('endEvent') || step.type === 'exclusiveGateway') return;
            if ((step.next || []).length > 0) return;
            const nextInLane = structure.steps.slice(idx + 1).find(n => n.role === step.role);
            if (nextInLane) {
                step.next = [nextInLane.id];
                console.warn(`FIX6: "${step.id}" sin salida → "${nextInLane.id}"`);
                return;
            }
            // Último del lane sin endEvent → agregar uno
            const laneHasEnd = structure.steps.some(n => n.role === step.role && n.type?.startsWith('endEvent'));
            if (!laneHasEnd) {
                const endId = `End_Auto_${step.id}`;
                structure.steps.push({ id: endId, name: 'Fin', type: 'endEvent', role: step.role, next: [] });
                step.next = [endId];
                console.warn(`FIX6: endEvent auto "${endId}" para "${step.id}"`);
            }
        });

        // FIX 7: limpiar lenguaje informal
        const informalMap = [
            [/^presionar?\s+/i,'Seleccionar '],[/^dar\s+clic\s+/i,'Seleccionar '],
            [/^hacer?\s+clic\s+/i,'Seleccionar '],[/^pulsar?\s+/i,'Activar '],
            [/^tocar?\s+/i,'Seleccionar '],[/clic/gi,''],[/botón/gi,'opción'],[/boton/gi,'opción'],
        ];

        // ── Split roles into two pools: Ciudadano and Brigadista ──────────────
        // Detect the split point: first lane with "brigadista" that follows
        // one or more "ciudadano" lanes. Each pool gets its own process and DI.
        const allRoles  = structure.roles;
        const allSteps  = structure.steps;
        const splitIdx  = (() => {
            for (let i = 1; i < allRoles.length; i++) {
                const hasBrig = allRoles[i].toLowerCase().includes('brigadista');
                const prevCiu = allRoles[i-1].toLowerCase().includes('ciudadano') ||
                                !allRoles[i-1].toLowerCase().includes('brigadista');
                if (hasBrig && prevCiu) return i;
            }
            return -1;  // no split found → single pool
        })();

        const processId  = `Process_${Date.now()}`;
        const processId2 = `Process_${Date.now() + 1}`;

        let logicXml, diXml, collaborationXml, finalXml;
        console.log('⚙️  Generando XML...');

        if (splitIdx > 0) {
            // Two-pool mode — UN solo archivo, dos pools apilados verticalmente.
            // Pool 1 (Ciudadano) arriba en y=60.
            // Pool 2 (Brigadista) debajo del Pool 1 con 60px de separación.
            // Ambos dentro de UNA collaboration y UN BPMNDiagram → un solo canvas limpio.
            const roles1  = allRoles.slice(0, splitIdx);
            const roles2  = allRoles.slice(splitIdx);
            const steps1  = allSteps.filter(s => roles1.includes(s.role));
            const steps2  = allSteps.filter(s => roles2.includes(s.role));
            const struct1 = { roles: roles1, steps: steps1 };
            const struct2 = { roles: roles2, steps: steps2 };

            const cleanPoolName1 = roles1.some(r => r.toLowerCase().includes('ciudadano'))   ? 'Portal Ciudadano'        : 'Proceso Ciudadano';
            const cleanPoolName2 = roles2.some(r => r.toLowerCase().includes('brigadista'))  ? 'Herramienta Brigadista'  : 'Proceso Brigadista';

            try {
                logicXml = generateLogic(struct1, processId, '') + '\n' + generateLogic(struct2, processId2, 'B');
            } catch (e) { throw new Error(`Error en generateLogic: ${e.message}`); }

            let di1, di2;
            try {
                di1 = generateDI(struct1, processId,  { poolY: 60,                  poolId: 'Participant_1', poolName: cleanPoolName1 });
                di2 = generateDI(struct2, processId2, { poolY: 60 + di1.poolH + 60, poolId: 'Participant_2', poolName: cleanPoolName2 });
                // Un solo BPMNDiagram con ambos pools apilados — uno arriba, otro abajo
                diXml = `  <bpmndi:BPMNDiagram id="BPMNDiagram_1" name="Proceso de Negocio">
    <bpmndi:BPMNPlane id="BPMNDiagram_1_Plane" bpmnElement="Collaboration_1">
${di1.shapesXml}${di2.shapesXml}${di1.edgesXml}${di2.edgesXml}    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>`;
            } catch (e) { throw new Error(`Error en generateDI: ${e.message}`); }

            collaborationXml = `  <collaboration id="Collaboration_1">
    <participant id="Participant_1" name="${xmlEscape(cleanPoolName1)}" processRef="${processId}"/>
    <participant id="Participant_2" name="${xmlEscape(cleanPoolName2)}" processRef="${processId2}"/>
  </collaboration>`;
        } else {
            // Single pool fallback
            try { logicXml = generateLogic(structure, processId); }
            catch (e) { throw new Error(`Error en generateLogic: ${e.message}`); }
            try {
                const di = generateDI(structure, processId, { poolY: 60, poolId: 'Participant_1', poolName: 'Proceso de Negocio' });
                diXml = `  <bpmndi:BPMNDiagram id="BPMNDiagram_1" name="Proceso de Negocio">
    <bpmndi:BPMNPlane id="BPMNDiagram_1_Plane" bpmnElement="Collaboration_1">
${di.shapesXml}${di.edgesXml}    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>`;
            } catch (e) { throw new Error(`Error en generateDI: ${e.message}`); }
            collaborationXml = `  <collaboration id="Collaboration_1">
    <participant id="Participant_1" name="Proceso de Negocio" processRef="${processId}"/>
  </collaboration>`;
        }

        finalXml = `<?xml version="1.0" encoding="utf-8"?>
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

        // ── Procesar diagramas adicionales si hay multi-proceso ──────────
        const bpmns = [{ name: allRawJsons[0]?.name || 'Proceso Principal', bpmn: finalXml }];

        for (let i = 1; i < allRawJsons.length; i++) {
            const { rawJson: rj, name } = allRawJsons[i];
            try {
                let js = rj.replace(/```json|```/g,'').trim()
                           .replace(/\/\/[^\n\r"]*/g,'')
                           .replace(/\/\*[\s\S]*?\*\//g,'')
                           .replace(/,\s*([}\]])/g,'$1');
                if (!js.trimEnd().endsWith('}')) {
                    const lb = js.lastIndexOf('}');
                    if (lb > 0) js = js.substring(0, lb+1) + '\n  ]\n}';
                }
                const struct = JSON.parse(js);
                if (!struct.roles?.length || !struct.steps?.length) throw new Error('sin roles/pasos');

                const pid = `Process_${Date.now()}_${i}`;
                const di  = generateDI(struct, pid, { poolY: 60, poolId: `Participant_${i+1}`, poolName: name });
                const xml = `<?xml version="1.0" encoding="utf-8"?>
<definitions
  xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
  xsi:schemaLocation="http://www.omg.org/spec/BPMN/20100524/MODEL http://www.omg.org/spec/BPMN/20100524/MODEL/BPMN20.xsd"
  id="Definitions_${i+1}"
  targetNamespace="http://www.bizagi.com/definitions/20250226143500"
  exporter="Bizagi Modeler"
  exporterVersion="3.4.0.013">
  <collaboration id="Collaboration_${i+1}">
    <participant id="Participant_${i+1}" name="${xmlEscape(name)}" processRef="${pid}"/>
  </collaboration>
${generateLogic(struct, pid)}
  <bpmndi:BPMNDiagram id="BPMNDiagram_${i+1}" name="${xmlEscape(name)}">
    <bpmndi:BPMNPlane id="BPMNDiagram_${i+1}_Plane" bpmnElement="Collaboration_${i+1}">
${di.shapesXml}${di.edgesXml}    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;
                bpmns.push({ name, bpmn: xml });
                console.log(`✓ BPMN adicional: "${name}" — ${struct.steps.length} pasos`);
            } catch(e) {
                console.warn(`WARN: diagrama extra "${name}" falló: ${e.message}`);
            }
        }

        console.log(`✓ Total BPMNs generados: ${bpmns.length} — ${structure.steps.length} pasos en el principal`);
        res.json({
            success: true,
            data:    mdMatch ? mdMatch[1].trim() : 'Análisis completado.',
            bpmn:    bpmns[0].bpmn,   // compatibilidad frontend existente
            bpmns,                     // array completo [{name, bpmn}]
        });

    } catch (error) {
        console.error('Error crítico:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============================================================
// 7. SERVIDOR
// ============================================================
const server = app.listen(4000, () =>
    console.log(`Servidor IA en puerto 4000 — modelo: ${CONFIG.model}`)
);
server.timeout          = CONFIG.timeout;
server.keepAliveTimeout = CONFIG.timeout;
// ============================================================
// 8. ENDPOINT DE DIAGNÓSTICO — /debug
// Procesa el PDF igual que /analyze pero devuelve texto plano
// describiendo qué sistemas detectó y qué estructura generaría,
// sin construir ningún XML. Útil para verificar el output de Gemini.
// ============================================================
app.post('/debug', upload.single('file'), async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    try {
        if (!req.file) return res.status(400).send('ERROR: Archivo no recibido.');

        const pdfData    = await pdf(req.file.buffer);
        const rawText    = pdfData.text.replace(/\s+/g, ' ').trim();
        const manualText = rawText.substring(0, CONFIG.maxPdfChars);
        if (manualText.length < 100) return res.status(400).send('ERROR: PDF sin texto extraíble.');

        const lines = [];
        const log = (...args) => { const msg = args.join(' '); console.log(msg); lines.push(msg); };

        log('═══════════════════════════════════════════════');
        log('DIAGNÓSTICO DE PROCESAMIENTO');
        log('═══════════════════════════════════════════════');
        log(`PDF leído: ${manualText.length} chars`);
        log(`Primeros 300 chars del texto extraído:`);
        log(manualText.substring(0, 300));
        log('───────────────────────────────────────────────');

        const model = genAI.getGenerativeModel({
            model: CONFIG.model,
            generationConfig: { temperature: CONFIG.temperature, maxOutputTokens: CONFIG.maxTokens },
        });

        async function callWithRetry(prompt, maxRetries = 3) {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const r = await model.generateContent(prompt);
                    return r.response.text();
                } catch(e) {
                    const msg = e.message || '';
                    const retry = (msg.includes('503') || msg.includes('429')) && attempt < maxRetries - 1;
                    if (retry) {
                        const wait = (attempt + 1) * 15000;
                        log(`Gemini saturado — esperando ${wait/1000}s...`);
                        await new Promise(r => setTimeout(r, wait));
                    } else throw e;
                }
            }
        }

        // ── PASO 1: Detectar sistemas ────────────────────────
        log('\nPASO 1 — DETECCIÓN DE SISTEMAS');
        log('Enviando prompt de detección a Gemini...');

        const detectPrompt = buildPromptDetect(manualText);
        log(`Tamaño del prompt de detección: ${detectPrompt.length} chars`);

        const detectRaw = await callWithRetry(detectPrompt);
        log(`\nRespuesta RAW de Gemini (detección completa):`);
        log('---');
        log(detectRaw);
        log('---');

        // Parsear
        let sistemas = null;
        const intentos = [
            detectRaw,
            detectRaw.replace(/```json|```/gi, '').trim(),
            detectRaw.substring(detectRaw.indexOf('{'), detectRaw.lastIndexOf('}') + 1),
        ];
        for (const intento of intentos) {
            try {
                const parsed = JSON.parse(intento);
                const arr = parsed.sistemas || parsed.actores || parsed.systems;
                if (Array.isArray(arr) && arr.length > 0) { sistemas = arr; break; }
            } catch(e) { /* continuar */ }
        }

        if (!sistemas) {
            log('\n⚠ PARSE FALLÓ — no se pudo extraer array de sistemas del JSON');
            log('Usando sistema genérico de fallback');
            sistemas = [{ nombre: 'Sistema Principal', descripcion: 'Flujo principal del manual' }];
        } else {
            log(`\n✓ Sistemas parseados correctamente: ${sistemas.length}`);
        }

        log(`\nSISTEMAS DETECTADOS (${sistemas.length}):`);
        sistemas.forEach((s, i) => log(`  ${i+1}. "${s.nombre}" — ${s.descripcion}`));

        // ── PASO 2: Por cada sistema, pedir solo el JSON de estructura ──
        log('\n═══════════════════════════════════════════════');
        log('PASO 2 — ESTRUCTURA DE CADA DIAGRAMA');
        log('═══════════════════════════════════════════════');

        for (let i = 0; i < sistemas.length; i++) {
            const sistema = sistemas[i];
            const otros   = sistemas.filter((_, j) => j !== i).map(s => s.nombre);
            log(`\n── Diagrama ${i+1}: "${sistema.nombre}" ──`);

            try {
                const raw = await callWithRetry(buildPromptDiagram(manualText, sistema.nombre, sistema.descripcion || '', otros));

                // Intentar parsear para mostrar resumen
                let estructura = null;
                try {
                    let js = raw.replace(/```json|```/g,'').trim();
                    js = js.replace(/,\s*([}\]])/g,'$1');
                    estructura = JSON.parse(js);
                } catch(e) {
                    // Intentar extraer JSON del medio del texto
                    const start = raw.indexOf('{');
                    const end   = raw.lastIndexOf('}');
                    if (start >= 0 && end > start) {
                        try { estructura = JSON.parse(raw.substring(start, end+1)); } catch(_) {}
                    }
                }

                if (estructura) {
                    log(`  ✓ JSON parseado correctamente`);
                    log(`  name: "${estructura.name}"`);
                    log(`  roles (${estructura.roles?.length ?? 0}): ${(estructura.roles || []).join(' | ')}`);
                    log(`  steps total: ${estructura.steps?.length ?? 0}`);

                    // Contar nodos por tipo
                    const byType = {};
                    (estructura.steps || []).forEach(s => { byType[s.type] = (byType[s.type]||0)+1; });
                    log(`  tipos: ${JSON.stringify(byType)}`);

                    // Contar nodos por rol
                    const byRole = {};
                    (estructura.roles || []).forEach(r => { byRole[r] = 0; });
                    (estructura.steps || []).forEach(s => { if (byRole[s.role] !== undefined) byRole[s.role]++; });
                    log(`  por rol:`);
                    Object.entries(byRole).forEach(([r, n]) => log(`    • ${r}: ${n} nodos`));

                    // Verificar integridad básica
                    const ids = new Set((estructura.steps||[]).map(s => s.id));
                    let broken = 0;
                    (estructura.steps||[]).forEach(s => {
                        (s.next||[]).forEach(nid => { if (!ids.has(nid)) broken++; });
                    });
                    const noNext = (estructura.steps||[]).filter(s =>
                        !s.type?.startsWith('endEvent') && !(s.next?.length > 0)
                    ).length;
                    log(`  referencias rotas: ${broken}`);
                    log(`  nodos sin next[]: ${noNext}`);
                } else {
                    log(`  ✗ JSON NO pudo parsearse`);
                    log(`  Respuesta RAW (primeros 500 chars):`);
                    log(raw.substring(0, 500));
                }
            } catch(e) {
                log(`  ✗ ERROR llamando Gemini: ${e.message}`);
            }
        }

        log('\n═══════════════════════════════════════════════');
        log('FIN DEL DIAGNÓSTICO');
        log('═══════════════════════════════════════════════');

        res.send(lines.join('\n'));

    } catch(error) {
        res.status(500).send(`ERROR CRÍTICO: ${error.message}\n${error.stack}`);
    }
});
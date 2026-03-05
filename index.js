require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const pdf     = require('pdf-parse');
const cors    = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
function generateLogic(structure, processId) {
    const { roles, steps } = structure;

    const lanes = roles.map((role, idx) => {
        const refs = steps
            .filter(s => s.role === role)
            .map(s => `        <flowNodeRef>${s.id}</flowNodeRef>`)
            .join('\n');
        return `      <lane id="Lane_${idx}" name="${xmlEscape(role)}">\n${refs}\n      </lane>`;
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
function generateDI(structure, processId) {
    const { roles, steps } = structure;

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

    const POOL_X      = 160;
    const POOL_Y      = 60;
    const LABEL_W     = 30;
    const LANE_X      = POOL_X + LABEL_W;
    const COL_W       = 250;   // px between column centers
    const ROW_H       = 160;   // px between row centers — extra space prevents arc crowding
    const LANE_PAD    = 55;    // top+bottom padding — arcs live in the top padding zone
    const START_CX    = LANE_X + 80; // center-x of column 0
    const MAX_PER_ROW = 5;     // max nodes per row — keeps most lanes to a single clean row
    const HW_MARGIN   = 420;   // extra px right of last node reserved for highway tracks

    const stepMap = {};
    steps.forEach(s => { stepMap[s.id] = s; });

    // ── 1. PER-LANE topological order ────────────────────────
    // For each lane: sort its nodes by their topological rank WITHIN the lane.
    // Nodes with no in-lane predecessors get rank 0.
    const laneOrder = {}; // role -> [stepId in topo order]

    roles.forEach(role => {
        const members = new Set(steps.filter(s => s.role === role).map(s => s.id));

        // Count in-lane in-degrees
        const inDeg = {};
        members.forEach(id => { inDeg[id] = 0; });
        members.forEach(id => {
            (stepMap[id]?.next || []).forEach(nid => {
                if (members.has(nid)) inDeg[nid]++;
            });
        });

        // BFS in JSON order for stability at equal ranks
        const queue = steps
            .filter(s => members.has(s.id) && inDeg[s.id] === 0)
            .map(s => s.id);
        if (!queue.length) {
            // fallback: just use JSON order
            laneOrder[role] = steps.filter(s => s.role === role).map(s => s.id);
            return;
        }

        const order = [];
        const seen = new Set();
        while (queue.length) {
            const id = queue.shift();
            if (seen.has(id)) continue;
            seen.add(id);
            order.push(id);
            (stepMap[id]?.next || []).forEach(nid => {
                if (members.has(nid) && !seen.has(nid)) queue.push(nid);
            });
        }
        // append any unreachable nodes (cycles / orphans)
        steps.filter(s => members.has(s.id) && !seen.has(s.id))
             .forEach(s => order.push(s.id));

        laneOrder[role] = order;
    });

    // ── 2. Assign (localCol, row) within each lane ───────────
    // Wrap every MAX_PER_ROW nodes onto a new row.
    const nodeLocalCol = {}; // id -> col within its lane
    const nodeRow      = {}; // id -> row within its lane

    roles.forEach(role => {
        (laneOrder[role] || []).forEach((id, idx) => {
            nodeRow[id]      = Math.floor(idx / MAX_PER_ROW);
            nodeLocalCol[id] = idx % MAX_PER_ROW;
        });
    });

    // ── 3. Lane heights ───────────────────────────────────────
    const laneRowCount = {}; // ri -> number of rows
    roles.forEach((role, ri) => {
        const ids = laneOrder[role] || [];
        laneRowCount[ri] = ids.length ? Math.ceil(ids.length / MAX_PER_ROW) : 1;
    });

    const laneH = {};
    roles.forEach((_, ri) => {
        laneH[ri] = LANE_PAD + laneRowCount[ri] * ROW_H + LANE_PAD;
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
        const col = nodeLocalCol[s.id] ?? 0;
        const row = nodeRow[s.id]      ?? 0;
        const cx  = START_CX + col * COL_W;
        const cy  = laneY[ri] + LANE_PAD + row * ROW_H + ROW_H / 2;
        pos[s.id] = { x: cx - w / 2, y: cy - h / 2, w, h, cx, cy };
    });

    // Pool width = widest lane content + right margin
    const maxContentX = Math.max(...steps.map(s => {
        const p = pos[s.id]; return p ? p.x + p.w : 0;
    }));

    // ── Hybrid cross-lane routing system ────────────────────────
    //
    // DOWN connections (source lane above target):
    //   Exit source BOTTOM → drop to src bottom-padding zone →
    //   travel RIGHT to a dedicated highway track →
    //   drop vertically to tgt top-padding zone →
    //   slide LEFT to tgtCX → enter target TOP
    //
    //   Tracks are staggered: closest-gap = innermost track (near content),
    //   furthest-gap = outermost track (further right). Each connection gets
    //   its own track, clearly visible and separated.
    //
    // UP connections (source lane below target):
    //   Exit source TOP → rise to src top-padding zone →
    //   travel LEFT to a dedicated left corridor track →
    //   rise vertically to tgt bottom-padding zone →
    //   slide RIGHT to tgtCX → enter target BOTTOM
    //
    //   Left corridor tracks fan leftward from LANE_X - 5.
    //   UP connections are typically few (module → menu returns),
    //   so the narrow left margin accommodates them.
    //
    // This gives a clean visual separation:
    //   Right side  = outgoing fan from hubs (clearly spread out)
    //   Left side   = return connections (compact, minimal)
    //   No horizontal segments at node level in any lane.

    const HW_BASE    = maxContentX + 40;   // first highway track X (right of all content)
    const HW_STAGGER = 20;                  // px between highway tracks (compact, still distinct)

    // ── Assign global highway tracks for ALL cross-lane connections ───────
    //
    // Both DOWN and UP connections use the RIGHT-SIDE highway.
    // This keeps ALL cross-lane lines in the visible right margin — no lines
    // hidden under the pool label.
    //
    // Track assignment:
    //   - All connections sorted by (srcLane, gap_size)
    //   - Each gets a globally unique track X = HW_BASE + globalRank * HW_STAGGER
    //   - DOWN connections: closest lane gap → innermost track (smallest X)
    //   - UP connections: interleaved after DOWN tracks of same source lane
    //   - This ensures connections from the same hub visually fan out right
    //     and return connections (UP) also clearly visible and separated.

    const hwXMap     = new Map();  // "srcId->tgtId" → highway track X
    const downRankMap = new Map(); // "srcId->tgtId" → rank within source (for paddingY)
    const upRankMap   = new Map(); // "srcId->tgtId" → rank within source (for paddingY)
    let   globalHWRank = 0;

    {
        // Collect ALL cross-lane connections (down and up)
        const allCross = [];
        steps.forEach(step => {
            const srcRi = roles.indexOf(step.role);
            (step.next || []).forEach(targetId => {
                const tgt = stepMap[targetId];
                if (!tgt) return;
                const tgtRi = roles.indexOf(tgt.role);
                if (tgtRi === srcRi) return;
                const gap  = Math.abs(tgtRi - srcRi);
                const dir  = tgtRi > srcRi ? 'down' : 'up';
                const col  = nodeLocalCol[step.id] ?? 0;
                allCross.push({ srcId: step.id, tgtId: targetId, srcRi, tgtRi, gap, dir, col });
            });
        });

        // Sort: by srcLane → then DOWN before UP → then by gap (closest first)
        allCross.sort((a, b) =>
            a.srcRi - b.srcRi ||
            (a.dir === 'down' ? 0 : 1) - (b.dir === 'down' ? 0 : 1) ||
            a.gap - b.gap ||
            a.col - b.col
        );

        // Assign per-source rank counters (for paddingY staggering)
        const srcDownCounter = new Map();
        const srcUpCounter   = new Map();

        allCross.forEach(e => {
            const key = `${e.srcId}->${e.tgtId}`;

            // Assign highway track
            hwXMap.set(key, HW_BASE + globalHWRank * HW_STAGGER);
            globalHWRank++;

            // Assign per-source rank for paddingY staggering
            if (e.dir === 'down') {
                const cnt = srcDownCounter.get(e.srcId) || 0;
                downRankMap.set(key, cnt);
                srcDownCounter.set(e.srcId, cnt + 1);
            } else {
                const cnt = srcUpCounter.get(e.srcId) || 0;
                upRankMap.set(key, cnt);
                srcUpCounter.set(e.srcId, cnt + 1);
            }
        });
    }

    // Pool width: accommodate the rightmost highway track
    const totalTracks = globalHWRank;
    const requiredW   = HW_BASE + totalTracks * HW_STAGGER + 60;
    const poolW       = Math.max(requiredW, maxContentX + HW_MARGIN) - POOL_X;

    // ── Helpers ───────────────────────────────────────────────
    const P   = id => pos[id];
    const R   = id => P(id).x + P(id).w;   // right edge x
    const L   = id => P(id).x;             // left edge x
    const T   = id => P(id).y;             // top edge y
    const B   = id => P(id).y + P(id).h;   // bottom edge y
    const CX  = id => P(id).cx;
    const CY  = id => P(id).cy;
    const wpt = pts => pts.map(([x, y]) =>
        `        <di:waypoint x="${Math.round(x)}" y="${Math.round(y)}"/>`).join('\n');

    // ── 6. Shapes XML ─────────────────────────────────────────
    let shapes = `      <bpmndi:BPMNShape id="Participant_1_di" bpmnElement="Participant_1" isHorizontal="true">
        <dc:Bounds x="${POOL_X}" y="${POOL_Y}" width="${poolW}" height="${poolH}"/>
      </bpmndi:BPMNShape>\n`;

    roles.forEach((_, i) => {
        shapes += `      <bpmndi:BPMNShape id="Lane_${i}_di" bpmnElement="Lane_${i}" isHorizontal="true">
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

    // ── 7. Edges XML ──────────────────────────────────────────
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
                //
                // The lane's top-padding zone (LANE_PAD px above the first row)
                // is reserved for backward arcs and wrap connectors.
                // Each arc gets a dedicated vertical slot within that zone
                // so arcs from different pairs never share the same Y line.
                //
                // Arc slots are spaced 12px apart starting from the top:
                //   slot 0 → laneY + 10
                //   slot 1 → laneY + 22
                //   slot 2 → laneY + 34
                //   ...
                // We use (srcCol + tgtCol) mod (available slots) to pick a slot,
                // giving each pair a consistent, spread-out arc height.

                const laneTop = laneY[srcRi];
                const ARC_SLOT_H = 12;  // px between arc slots
                const ARC_SLOTS  = Math.floor((LANE_PAD - 10) / ARC_SLOT_H); // how many slots fit
                const srcCol     = nodeLocalCol[step.id]   ?? 0;
                const tgtCol     = nodeLocalCol[targetId]  ?? 0;

                if (srcRow === tgtRow && x2 > x1) {
                    // ── Forward, same row → straight horizontal ──────────
                    pts = [[x1, y1], [x2, y2]];

                } else if (srcRow < tgtRow && nodeLocalCol[targetId] === 0) {
                    // ── Row wrap (forward, source last col → next row col 0) ─
                    // Exit right → travel down the right margin → re-enter left.
                    // The right margin is between the last column and the pool edge.
                    // This keeps the path clear of all node content.
                    const wrapX  = START_CX + (MAX_PER_ROW - 1) * COL_W + 80;  // right of last node
                    const midY   = laneY[srcRi] + LANE_PAD + (srcRow + 1) * ROW_H; // between the two rows
                    pts = [
                        [x1,           y1],
                        [wrapX,        y1],
                        [wrapX,        midY],
                        [START_CX - 50, midY],
                        [START_CX - 50, y2],
                        [x2,           y2],
                    ];

                } else if (srcRow === tgtRow && x2 < x1) {
                    // ── Backward loop within same row ────────────────────
                    // Arc goes ABOVE the lane, into the top-padding zone.
                    // Slot is chosen by (srcCol % ARC_SLOTS) to spread arcs out.
                    const slot   = srcCol % Math.max(1, ARC_SLOTS);
                    const arcY   = laneTop + 10 + slot * ARC_SLOT_H;
                    pts = [
                        [x1,      y1],
                        [x1 + 12, y1],
                        [x1 + 12, arcY],
                        [x2 - 12, arcY],
                        [x2 - 12, y2],
                        [x2,      y2],
                    ];

                } else if (srcRow > tgtRow) {
                    // ── Cross-row backward (e.g. row2 → row1) ───────────
                    // Route via the BOTTOM padding zone to avoid the wrap path.
                    // Exit right → go to right margin → rise to target row → enter left.
                    const wrapX = START_CX + (MAX_PER_ROW - 1) * COL_W + 80;
                    pts = [
                        [x1,           y1],
                        [wrapX,        y1],
                        [wrapX,        y2],
                        [x2,           y2],
                    ];

                } else {
                    // ── Forward, different row, non-zero target col ──────
                    const midX = Math.round((x1 + x2) / 2);
                    pts = [[x1, y1], [midX, y1], [midX, y2], [x2, y2]];
                }
            } else {
                // ── Cross-lane — Unified RIGHT-HIGHWAY routing ──────────────
                //
                // ALL cross-lane connections (DOWN and UP) travel through the
                // RIGHT-SIDE highway zone. Each gets its own unique track X,
                // so all lines are clearly visible and separated — no bundling.
                //
                // DOWN path (source above target):
                //   Exit source BOTTOM → drop into src bottom-padding slot →
                //   slide RIGHT to dedicated highway track X →
                //   drop to tgt top-padding → slide LEFT to tgtCX → enter TOP.
                //
                // UP path (source below target):
                //   Exit source TOP → rise into src top-padding slot →
                //   slide RIGHT to dedicated highway track X →
                //   rise to tgt bottom-padding → slide LEFT to tgtCX → enter BOTTOM.
                //
                // paddingY slots are staggered 12px per rank so multiple connections
                // from the same source node don't overlap near the source.

                const srcCX     = CX(step.id);
                const tgtCX     = CX(targetId);
                const srcBottom = B(step.id);
                const srcTop    = T(step.id);
                const tgtBottom = B(targetId);
                const tgtTop    = T(targetId);
                const hwX       = hwXMap.get(`${step.id}->${targetId}`) ?? HW_BASE;

                if (srcRi < tgtRi) {
                    // ── Going DOWN ────────────────────────────────────────
                    const rank     = downRankMap.get(`${step.id}->${targetId}`) ?? 0;
                    const padBase  = laneY[srcRi] + laneH[srcRi] - Math.round(LANE_PAD / 2);
                    const paddingY = padBase - rank * 12;
                    const tgtPadY  = laneY[tgtRi] + Math.round(LANE_PAD / 2);

                    pts = [
                        [srcCX,  srcBottom],  // exit source bottom
                        [srcCX,  paddingY],   // drop into src bottom-padding slot
                        [hwX,    paddingY],   // slide right to highway
                        [hwX,    tgtPadY],    // drop to tgt top-padding
                        [tgtCX,  tgtTop],     // slide left, enter target top
                    ];
                } else {
                    // ── Going UP ─────────────────────────────────────────
                    const rank     = upRankMap.get(`${step.id}->${targetId}`) ?? 0;
                    const padBase  = laneY[srcRi] + Math.round(LANE_PAD / 2);
                    const paddingY = padBase + rank * 12;
                    const tgtPadY  = laneY[tgtRi] + laneH[tgtRi] - Math.round(LANE_PAD / 2);

                    pts = [
                        [srcCX,  srcTop],     // exit source top
                        [srcCX,  paddingY],   // rise into src top-padding slot
                        [hwX,    paddingY],   // slide right to highway
                        [hwX,    tgtPadY],    // rise to tgt bottom-padding
                        [tgtCX,  tgtBottom],  // slide left, enter target bottom
                    ];
                }
            }

            edges += `      <bpmndi:BPMNEdge id="${edgeId}" bpmnElement="${flowId}">
${wpt(pts)}
      </bpmndi:BPMNEdge>\n`;
        });
    });

    return `  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">
${shapes}${edges}    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>`;
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

Conectar secciones:
  ✅ última_tarea_lane1 → intermediateEvent_inicio_lane2 → primera_tarea_lane2
  ❌ última_tarea → endEvent → intermediateEvent  (endEvent termina todo, no puede conectar)
  ❌ intermediateEvent sin ningún nodo apuntando a él (queda flotante, inválido)

Menú / hub con múltiples módulos:
  ✅ tarea_visualizar_menu → "next": ["Evt_ModA", "Evt_ModB", ..., "Evt_CerrarSesion"]
  Cada Evt_ModX → primera tarea de ese módulo
  Evt_CerrarSesion → tarea cerrar sesión → endEvent

═══════════════════════════════════════════════════════════
REGLA 3 — ESTRUCTURA DE LANES (OBLIGATORIA)
═══════════════════════════════════════════════════════════
Cada lane = UNA sección funcional. Orden fijo para cada tipo de usuario:

  1. Inicio de sesión         ← startEvent va aquí
  2. Pre-registro (si existe) ← dividir en Parte 1 / Parte 2 si > 8 nodos
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
• Máximo 8 nodos por lane. Si hay más → dividir: "Sección - Parte 1", "Sección - Parte 2"
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

        const result       = await model.generateContent(buildPrompt(manualText));
        const responseText = result.response.text();
        console.log(`Gemini respondió en ${((Date.now() - t0) / 1000).toFixed(1)}s — ${responseText.length} chars`);

        // ── Extracción robusta: intenta con etiquetas completas primero,
        //    luego intenta reparar si viene truncado
        const mdMatch   = responseText.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);
        const jsonMatch = responseText.match(/\[JSON_START\]([\s\S]*?)\[JSON_END\]/);

        let rawJson = null;
        if (jsonMatch) {
            rawJson = jsonMatch[1];
        } else {
            const partial = responseText.match(/\[JSON_START\]([\s\S]*)/);
            if (partial) {
                console.warn('Respuesta truncada — intentando reparar JSON...');
                rawJson = partial[1];
            }
        }

        if (!rawJson) {
            console.error('Sin JSON en respuesta:', responseText.substring(0, 300));
            throw new Error('Gemini no devolvió JSON válido. Intenta de nuevo.');
        }

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

        // FIX 1: endEvent/endEventMessage con "next" no vacío
        // Si un endEvent apunta a un intermediateEvent, eliminar ese next del endEvent.
        // La conexión correcta es: el task ANTERIOR al endEvent → intermediateEvent.
        structure.steps.forEach(step => {
            if (step.type === 'endEvent' || step.type === 'endEventMessage') {
                if (step.next && step.next.length > 0) {
                    console.warn(`FIX: endEvent "${step.id}" tenía next=[${step.next}] — se elimina`);
                    step.next = [];
                }
            }
        });

        // FIX 2: intermediateEvent sin entrada (flotante)
        // Si un intermediateEvent no tiene ningún nodo que apunte a él,
        // busca si algún endEvent lo apuntaba antes del fix y reconecta desde el
        // predecessor lógico (el nodo que apuntaba al endEvent).
        const allNextIds = new Set(structure.steps.flatMap(s => s.next || []));
        structure.steps.forEach(step => {
            if ((step.type === 'intermediateEvent' || step.type === 'intermediateEventMessage')
                && !allNextIds.has(step.id)) {
                // Find a predecessor: any step in the same or previous role that has no next connection
                // to this event. Try to connect from the last step of the previous role.
                const myRoleIdx = structure.roles.indexOf(step.role);
                if (myRoleIdx > 0) {
                    const prevRole = structure.roles[myRoleIdx - 1];
                    const prevSteps = structure.steps.filter(s => s.role === prevRole);
                    // The last "end" step or last task in prevRole
                    const lastPrev = prevSteps.filter(s =>
                        s.type === 'endEvent' || s.type === 'endEventMessage' || s.type === 'userTask' || s.type === 'serviceTask' || s.type === 'scriptTask'
                    ).pop();
                    if (lastPrev && !lastPrev.next?.includes(step.id)) {
                        // If lastPrev is an endEvent, convert it back to a task or just add the connection
                        if (lastPrev.type === 'endEvent' || lastPrev.type === 'endEventMessage') {
                            // Change the endEvent to a task that flows forward
                            console.warn(`FIX: Converting end "${lastPrev.id}" to userTask to connect to floating "${step.id}"`);
                            lastPrev.type = 'userTask';
                            lastPrev.next = [step.id];
                        } else {
                            console.warn(`FIX: Adding connection ${lastPrev.id} → ${step.id} (was floating)`);
                            lastPrev.next = [...(lastPrev.next || []), step.id];
                        }
                    }
                }
            }
        });

        // FIX 3: Lenguaje informal en nombres de tareas
        const informalMap = [
            [/^presionar?\s+/i,   'Seleccionar '],
            [/^dar\s+clic\s+/i,   'Seleccionar '],
            [/^hacer?\s+clic\s+/i,'Seleccionar '],
            [/^pulsar?\s+/i,      'Activar '],
            [/^tocar?\s+/i,       'Seleccionar '],
            [/clic/gi,        ''],
            [/botón/gi,       'opción'],
            [/boton/gi,       'opción'],
        ];
        structure.steps.forEach(step => {
            if (step.name) {
                let name = step.name;
                informalMap.forEach(([pattern, replacement]) => {
                    name = name.replace(pattern, replacement);
                });
                // Clean up extra spaces
                name = name.replace(/\s{2,}/g, ' ').trim();
                if (name !== step.name) {
                    console.warn(`FIX lenguaje: "${step.name}" → "${name}"`);
                    step.name = name;
                }
            }
        });

        // Validar que los roles de cada step existen en la lista de roles
        structure.steps.forEach(step => {
            if (!structure.roles.includes(step.role)) {
                console.warn(`Step "${step.id}" tiene rol desconocido "${step.role}" — asignando al primer rol`);
                step.role = structure.roles[0];
            }
        });

        const processId = `Process_${Date.now()}`;

        console.log('⚙️  Generando XML...');
        let logicXml, diXml;
        try {
            logicXml = generateLogic(structure, processId);
            console.log('✓ generateLogic OK');
        } catch (e) {
            throw new Error(`Error en generateLogic: ${e.message}`);
        }
        try {
            diXml = generateDI(structure, processId);
            console.log('✓ generateDI OK');
        } catch (e) {
            throw new Error(`Error en generateDI: ${e.message}`);
        }

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
  <collaboration id="Collaboration_1">
    <participant id="Participant_1" name="Proceso de Negocio" processRef="${processId}"/>
  </collaboration>
${logicXml}
${diXml}
</definitions>`;

        console.log(`✓ BPMN generado — ${structure.steps.length} pasos, ${structure.roles.length} roles`);
        res.json({
            success: true,
            data:    mdMatch ? mdMatch[1].trim() : 'Análisis completado.',
            bpmn:    finalXml,
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
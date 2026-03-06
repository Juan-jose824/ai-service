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
    return `ROL DEL MODELO

Actúa como arquitecto senior de procesos especializado en BPMN 2.0, arquitectura de sistemas y análisis funcional de plataformas digitales.

Tu tarea es analizar manuales de usuario, documentación funcional o descripciones operativas de sistemas y convertirlos en modelos BPMN claros, consistentes y técnicamente correctos.

El objetivo es generar modelos que permitan comprender:

• cómo funciona la plataforma
• qué actores participan
• qué sistemas intervienen
• cómo se conectan los procesos

Los diagramas deben ser comprensibles para analistas de procesos, arquitectos de sistemas y equipos técnicos.

Evita diagramas confusos, actividades ambiguas o flujos cruzados.

------------------------------------------------------------

OBJETIVO DEL ANÁLISIS

A partir del documento debes identificar:

• procesos del sistema
• módulos funcionales
• roles de usuario
• sistemas involucrados
• integraciones entre sistemas
• APIs o servicios
• etapas del proceso

Después debes generar un modelo BPMN estructurado.

------------------------------------------------------------

FASE 0 — ANÁLISIS ARQUITECTÓNICO DE LA PLATAFORMA

Antes de generar cualquier proceso debes analizar la estructura del sistema.

0.1 MÓDULOS DEL SISTEMA

Identifica los módulos funcionales principales.

Ejemplo:

Registro de usuarios
Gestión de citas
Credencialización
Administración
Activación de servicios
Soporte
Reportes

Cada módulo agrupa procesos relacionados.

------------------------------------------------------------

0.2 ROLES DEL SISTEMA

Identifica los roles que interactúan con la plataforma.

Ejemplo:

Usuario
Operador
Administrador
Call Center
Sistema automático
Sistema externo

Los roles representan quién ejecuta cada actividad.

------------------------------------------------------------

0.3 PROCESOS POR MÓDULO

Dentro de cada módulo identifica los procesos que lo componen.

Ejemplo:

Módulo: Gestión de citas

Consultar disponibilidad
Asignar cita
Confirmar cita
Modificar cita
Cancelar cita

------------------------------------------------------------

0.4 SISTEMAS INVOLUCRADOS

Identifica los sistemas o plataformas que participan en el flujo.

Ejemplo:

Sistema de Registro
Sistema de Citas
Sistema de Credencialización
Sistema Financiero
Sistema de Soporte
Sistema de Notificaciones

------------------------------------------------------------

0.5 INTEGRACIONES ENTRE SISTEMAS

Detecta cuando un sistema consulta o envía información a otro.

Ejemplo:

API validación de usuario
API consulta de citas
API activación de credencial
API confirmación de entrega

Estas integraciones se representarán como Service Tasks.

------------------------------------------------------------

FASE 1 — IDENTIFICACIÓN DEL PROCESO PRINCIPAL

Define el proceso principal descrito en el manual.

Ejemplo:

Proceso de credencialización
Proceso de registro de usuario
Proceso de activación de servicio
Proceso de gestión de citas

------------------------------------------------------------

FASE 2 — IDENTIFICACIÓN DE SUBPROCESOS

Si el manual describe varias etapas o módulos dentro del proceso principal, conviértelos en subprocesos.

Ejemplo:

Proceso: Credencialización

Subprocesos:

Pre-registro
Validación de información
Gestión de citas
Entrega de credencial
Activación
Soporte y reposición

REGLA

Si un módulo contiene más de 7 actividades, modelarlo como subproceso.

Si contiene menos actividades, usar tareas normales.

------------------------------------------------------------

FASE 3 — DEFINICIÓN DE ETAPAS DEL PROCESO

Divide el proceso en etapas funcionales.

Las etapas se representarán como lanes.

Ejemplo:

Pre-registro
Validación
Gestión de citas
Entrega
Activación
Soporte

Cada etapa debe contener preferentemente entre 3 y 7 actividades.

------------------------------------------------------------

FASE 4 — MODELO HÍBRIDO DE RESPONSABILIDADES

El BPMN debe organizarse de la siguiente forma:

LANES

Representan etapas del proceso.

RESPONSABLE

Cada tarea debe indicar el rol responsable.

Ejemplo:

Registrar solicitud
Responsable: Usuario

SISTEMA

Cada tarea puede indicar el sistema que ejecuta la acción.

Ejemplo:

Validar datos
Sistema: Sistema de Registro

------------------------------------------------------------

FASE 5 — ELEMENTOS BPMN

Usar correctamente:

Start Event
End Event
User Task
System Task
Service Task
Exclusive Gateway (XOR)

Ejemplos:

User Task
Registrar solicitud

System Task
Validar información

Service Task
Consultar API de usuarios

Gateway
¿Datos válidos?

Cada gateway debe tener condiciones claras.

------------------------------------------------------------

FASE 6 — REGLAS DE DISEÑO DEL DIAGRAMA

El flujo debe avanzar de izquierda a derecha.

Evitar cruces de líneas.

Cada tarea debe representar una acción del proceso.

No describir acciones de interfaz como:

hacer clic
presionar botón
seleccionar menú

Usar acciones del proceso:

Registrar solicitud
Validar información
Confirmar registro

------------------------------------------------------------

FASE 7 — REPRESENTACIÓN DE APIs

Las integraciones deben representarse como Service Tasks.

Ejemplo:

API Consulta de Usuario
API Consulta de Citas
API Activación de Credencial
API Confirmación de Entrega

------------------------------------------------------------

REGLA CRÍTICA

No inventar procesos que el documento no describa.

Sin embargo, puedes inferir validaciones o decisiones cuando el flujo lo implique para mantener coherencia del proceso.

------------------------------------------------------------

REGLAS TÉCNICAS OBLIGATORIAS PARA EL JSON

• endEvent / endEventMessage NUNCA tiene "next" con valores. Siempre "next": []
• intermediateEvent SIEMPRE tiene exactamente 1 entrada y 1 salida.
• UN startEvent por tipo de usuario, siempre en su lane de inicio.
• IDs únicos, sin espacios: Start_Xxx, Task_Xxx, GW_Xxx, Evt_Xxx, End_Xxx
• NUNCA referencias circulares directas: A → B → A
• "conditions" obligatorio en exclusiveGateway con más de una salida.
• Máximo 5 nodos por lane. Si hay más → dividir OBLIGATORIAMENTE en "Sección - Parte 1", "Sección - Parte 2".
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

------------------------------------------------------------

FORMATO DE SALIDA OBLIGATORIO

[MD_START]
**Módulos identificados:** lista
**Roles detectados:** lista
**Sistemas involucrados:** lista
**Integraciones detectadas:** lista
**APIs identificadas:** lista
**Etapas del proceso:** lista
**Pasos totales:** número
**Flujo general:** 2-3 líneas
[MD_END]
[JSON_START]
{
  "roles": ["Etapa 1", "Etapa 2", "..."],
  "steps": [
    { "id": "Start_Xxx", "name": "Nombre", "type": "startEvent", "role": "Etapa 1", "next": ["Task_Xxx"] },
    { "id": "Task_Xxx", "name": "Nombre", "type": "userTask", "role": "Etapa 1", "next": ["End_Xxx"] },
    { "id": "End_Xxx", "name": "Nombre", "type": "endEvent", "role": "Etapa 1", "next": [] }
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
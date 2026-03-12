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

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },  // 50 MB máximo
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
            cb(null, true);
        } else {
            cb(new Error('Solo se aceptan archivos PDF.'));
        }
    },
});
const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const CONFIG = {
    model:       'gemini-2.5-flash',
    maxPdfChars: 120_000,   // subido de 50k — manuales grandes necesitan más contexto
    maxTokens:   65_536,
    temperature: 0,
    timeout:     180_000,   // 3 min para PDFs grandes
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
// 4. GENERADOR DE LAYOUT (BPMN DI) — estilo Bizagi profesional
//
//  ESTRATEGIA DE ROUTING ANTI-SOLAPAMIENTO:
//  ─────────────────────────────────────────
//  Nodos: lane height fija 360 px, centrados verticalmente.
//  Tasks 120×80 | Events 36×36 | Gateways 50×50 | COL_W 260 px
//
//  Same-lane:
//    • Forward: línea recta R(src)→L(tgt) a la misma Y central
//    • Backward: arco limpio por encima del lane (arcY único por src)
//    • Wrap (2ª fila): sale derecha → baja → vuelve a col 0
//
//  Cross-lane — highway DERECHO escalonado:
//    • CADA arista tiene su propia pista vertical (hwX único)
//    • Sale por R(src)+margen_col → baja/sube dentro del lane actual
//      hasta un slot Y en el borde del lane (staggered por col fuente)
//    • Viaja horizontalmente hasta hwX
//    • Viaja verticalmente hasta el borde del lane destino
//    • Entra por L(tgt) horizontalmente
//    • Esto garantiza que NINGUNA línea comparte coordenadas con otra
// ============================================================
function generateDI(structure, processId, poolOpts = {}) {
    const { roles, steps } = structure;
    const POOL_ID   = poolOpts.poolId   ?? 'Participant_1';
    const POOL_Y    = poolOpts.poolY    ?? 60;
    const LANE_PFX  = POOL_ID === 'Participant_1' ? '' : 'B';

    // ── Node dimensions ───────────────────────────────────────
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

    // ── Layout constants (calibrated vs. professional Bizagi reference) ──────
    // Professional reference: lane h≈350, tasks w=90-120 h=60, events w/h=30
    // Column gap ≈ 190px center-to-center, first node cx≈310 from pool left
    const POOL_X      = 160;              // pool label block
    const LABEL_W     = 30;              // pool label width
    const LANE_X      = POOL_X + LABEL_W; // 190 — lane left edge
    const LANE_H      = 350;              // lane height, single row
    const LANE_H_2    = 700;              // lane height, two rows
    const COL_W       = 190;              // center-to-center column spacing
    const MAX_COLS    = 7;                // 7 nodes fit in one row (310 + 6*190 = 1450)
    const COL0_CX     = LANE_X + 120;    // center-x of column 0 = 310

    // Highway: cross-lane edges route right of all nodes, one track per edge
    const HW_STEP     = 20;

    const stepMap = {};
    steps.forEach(s => { stepMap[s.id] = s; });

    // ── 1. Topological sort per lane ─────────────────────────
    const laneOrder = {};
    roles.forEach(role => {
        const members = new Set(steps.filter(s => s.role === role).map(s => s.id));
        const inDeg = {};
        members.forEach(id => { inDeg[id] = 0; });
        members.forEach(id => {
            (stepMap[id]?.next || []).forEach(nid => {
                if (members.has(nid)) inDeg[nid] = (inDeg[nid] || 0) + 1;
            });
        });
        const queue = [...members].filter(id => !inDeg[id]);
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
        members.forEach(id => { if (!seen.has(id)) order.push(id); });
        laneOrder[role] = order;
    });

    // ── 2. Assign col/row ────────────────────────────────────
    const nodeCol = {}, nodeRow = {}, laneRows = {};
    roles.forEach(role => {
        const order = laneOrder[role] || [];
        let maxRow = 0;
        order.forEach((id, idx) => {
            nodeCol[id] = idx % MAX_COLS;
            nodeRow[id] = Math.floor(idx / MAX_COLS);
            maxRow = Math.max(maxRow, nodeRow[id]);
        });
        laneRows[role] = maxRow + 1;
    });

    // ── 3. Lane heights & Y positions ────────────────────────
    const laneH = {}, laneY = {};
    let curY = POOL_Y;
    roles.forEach((role, ri) => {
        laneH[ri] = laneRows[role] <= 1 ? LANE_H : LANE_H_2;
        laneY[ri] = curY;
        curY += laneH[ri];
    });
    const poolH = curY - POOL_Y;

    // ── 4. Node pixel positions ───────────────────────────────
    const pos = {};
    steps.forEach(s => {
        const { w, h } = sz(s.type);
        const ri  = roles.indexOf(s.role);
        const col = nodeCol[s.id] ?? 0;
        const row = nodeRow[s.id] ?? 0;
        const cx  = COL0_CX + col * COL_W;
        const cy  = laneY[ri] + row * LANE_H + LANE_H / 2;
        pos[s.id] = {
            x: Math.round(cx - w / 2), y: Math.round(cy - h / 2),
            w, h,
            cx: Math.round(cx), cy: Math.round(cy),
        };
    });

    // ── 5. Pool width ─────────────────────────────────────────
    const maxNodeRight = steps.reduce((m, s) => {
        const p = pos[s.id]; return p ? Math.max(m, p.x + p.w) : m;
    }, COL0_CX + (MAX_COLS - 1) * COL_W + 60);

    // highway starts 60 px after last node
    const HW_BASE = maxNodeRight + 60;

    // ── 6. Assign highway tracks to cross-lane edges ─────────
    // Sort so that longer-spanning edges get outer (larger hwX) tracks
    // This keeps shorter connections close to the pool content,
    // longer ones further right — mirrors professional Bizagi output.
    const hwMap  = new Map();   // "src→tgt" → { hwX, exitSlotY, enterSlotY }
    let   hwIdx  = 0;

    {
        const cross = [];
        steps.forEach(s => {
            const si = roles.indexOf(s.role);
            (s.next || []).forEach(tid => {
                const t = stepMap[tid];
                if (!t) return;
                const ti = roles.indexOf(t.role);
                if (ti !== si) {
                    cross.push({
                        src: s.id, tgt: tid, si, ti,
                        gap: Math.abs(ti - si),
                        col: nodeCol[s.id] ?? 0,
                    });
                }
            });
        });
        // Longer gap → outer track; ties broken by source lane then column
        cross.sort((a, b) =>
            b.gap - a.gap ||
            a.si  - b.si  ||
            a.col - b.col
        );
        cross.forEach(e => {
            const key = `${e.src}->${e.tgt}`;
            if (!hwMap.has(key)) {
                hwMap.set(key, HW_BASE + hwIdx * HW_STEP);
                hwIdx++;
            }
        });
    }

    const poolW = Math.max(
        1760,
        HW_BASE + hwIdx * HW_STEP + 80
    );

    // ── Helpers ───────────────────────────────────────────────
    const P   = id => pos[id];
    const R   = id => P(id).x + P(id).w;
    const L   = id => P(id).x;
    const CX  = id => P(id).cx;
    const CY  = id => P(id).cy;
    const wpt = pts => pts.map(([x, y]) =>
        `        <di:waypoint x="${Math.round(x)}" y="${Math.round(y)}"/>`).join('\n');

    // ── 7. Shapes ─────────────────────────────────────────────
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
        <dc:Bounds x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>
      </bpmndi:BPMNShape>\n`;
    });

    // ── 8. Edges ──────────────────────────────────────────────
    let edges = '';

    steps.forEach(step => {
        if (!P(step.id)) return;
        const srcRi = roles.indexOf(step.role);

        (step.next || []).forEach(targetId => {
            if (!P(targetId)) return;
            const tgtRi  = roles.indexOf(stepMap[targetId]?.role);
            const edgeId = `Edge_${step.id}_${targetId}`;
            const flowId = `Flow_${step.id}_${targetId}`;
            let pts;

            if (srcRi === tgtRi) {
                // ── Same-lane routing ──────────────────────────
                const srcRow = nodeRow[step.id] ?? 0;
                const tgtRow = nodeRow[targetId] ?? 0;

                if (srcRow < tgtRow) {
                    // Wrap: exit right → wrapX → down past divider → returnX → enter col0 row1
                    // Stagger per lane index to avoid overlap between different lane wraps
                    const wrapX   = HW_BASE - 40 + srcRi * 4;
                    const returnX = LANE_X + 10 + srcRi * 4;
                    const midY    = laneY[srcRi] + (srcRow + 1) * LANE_H - 15;
                    pts = [
                        [R(step.id),   CY(step.id)],
                        [wrapX,        CY(step.id)],
                        [wrapX,        midY],
                        [returnX,      midY],
                        [returnX,      CY(targetId)],
                        [L(targetId),  CY(targetId)],
                    ];
                } else if (CX(targetId) <= CX(step.id)) {
                    // Backward: arc above lane top padding
                    const arcY = laneY[srcRi] + 14;
                    pts = [
                        [R(step.id),       CY(step.id)],
                        [R(step.id) + 10,  CY(step.id)],
                        [R(step.id) + 10,  arcY],
                        [L(targetId) - 10, arcY],
                        [L(targetId) - 10, CY(targetId)],
                        [L(targetId),      CY(targetId)],
                    ];
                } else {
                    // Simple forward straight line
                    pts = [[R(step.id), CY(step.id)], [L(targetId), CY(targetId)]];
                }

            } else {
                // ── Cross-lane highway routing ─────────────────
                // Each edge has its own hwX track → no shared verticals
                const key = `${step.id}->${targetId}`;
                const hwX = hwMap.get(key) ?? HW_BASE;
                pts = [
                    [R(step.id),  CY(step.id)],
                    [hwX,         CY(step.id)],
                    [hwX,         CY(targetId)],
                    [L(targetId), CY(targetId)],
                ];
            }

            // ── Condition label ───────────────────────────────
            const condText = step.conditions?.[targetId];
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
REGLA 2 — DIRECCIÓN DEL FLUJO (LEY FUNDAMENTAL DE LAYOUT)
═══════════════════════════════════════════════════════════
El diagrama se lee DE IZQUIERDA A DERECHA dentro de cada lane.
Una flecha BAJA al siguiente lane SOLO si el proceso continúa ahí.
Si el proceso termina, usa un endEvent — NUNCA bajes sin continuación.

FLUJO CORRECTO:
  startEvent → task → task → task → endEvent
                                        ↓ (solo si hay más proceso)
                               intermediateEvent → task → endEvent

• endEvent / endEventMessage → NUNCA tiene "next". Siempre "next": []
• Cuando una sección TERMINA su trabajo → poner endEvent y listo.
• Solo poner flecha al siguiente lane cuando la acción del lane actual
  DESENCADENA directamente otra sección del proceso.
• intermediateEvent = conector entre secciones. SIEMPRE: 1 entrada + 1 salida.
• PROHIBIDO conectar nodos de distintos usuarios (Ciudadano ↔ Brigadista).
• PROHIBIDO endEvent → cualquier otro nodo.

CONECTAR SECCIONES CORRECTAMENTE:
  ✅ última_tarea_lane1 → intermediateEvent_inicio_lane2 → primera_tarea_lane2
  ❌ última_tarea → endEvent → intermediateEvent  (endEvent no puede conectar)
  ❌ intermediateEvent flotante sin nada apuntando a él (nodo huérfano)
  ❌ End_SesionCerradaCiudadano → Evt_Brigadista  (cross-pool PROHIBIDO)

CUÁNDO BAJAR AL SIGUIENTE LANE (poner flecha hacia abajo):
  ✅ Pre-registro completa → verificación de cuenta necesaria → bajar
  ✅ Login exitoso → menú principal → bajar
  ✅ Menú selecciona módulo → módulo correspondiente → bajar
  ❌ Módulo A completa su tarea → NO baja al Módulo B (son ramas independientes)
  ❌ Cerrar sesión completa → NO baja al proceso del otro usuario

MENÚ / HUB CON MÚLTIPLES MÓDULOS:
  ✅ tarea_visualizar_menu → "next": ["Evt_ModA", "Evt_ModB", ..., "Evt_CerrarSesion"]
  Cada Evt_ModX → primera tarea de ese módulo → ... → endEvent (no vuelve)
  Evt_CerrarSesion → tarea cerrar sesión → endEvent

MÓDULOS CON SUB-RAMAS (ej: Gestión tiene Crear Y Buscar/Editar):
  ✅ Evt_Gestion → "next": ["Task_Crear", "Task_Buscar"]
  Cada rama termina en su propio endEvent. NO intermediateEvents intermedios.

═══════════════════════════════════════════════════════════
REGLA 3 — ESTRUCTURA DE LANES (OBLIGATORIA)
═══════════════════════════════════════════════════════════
Cada lane = UNA sección funcional. Orden fijo para cada tipo de usuario:

  1. Inicio de sesión         ← startEvent va aquí
  2. Pre-registro (si existe) ← dividir en Parte 1 / Parte 2 si > 5 nodos
  3. Recuperación contraseña  ← si el manual lo describe
  4. Verificación de cuenta   ← si el manual lo describe
  5. Menú principal           ← siempre presente
  6. [Un lane por cada módulo listado en el menú]
  7. Cerrar sesión            ← siempre el último

Si hay DOS tipos de usuario → DOS bloques de lanes independientes, cada uno con su startEvent.
NO crear gateway de selección de usuario/portal — son flujos separados.

TODOS los módulos del menú deben tener su propio lane.
Si el menú lista 6 módulos → 6 lanes de módulos. No resumir en uno solo.

REGLA DE "PARTE 1.2" PARA SECCIONES MULTI-FASE:
Si una sección tiene pasos que continúan en otra sub-sección (ej: Pre-registro
parte 2 lleva a verificación, pero Pre-registro parte 2.2 tiene pasos adicionales):
  ✅ La sub-sección "Parte X.2" puede contener: intermediateEvent de continuación
     + las tareas siguientes. El endEvent de la parte anterior (X.1) se convierte
     en intermediateEvent si el flujo continúa en la siguiente parte.
  ❌ No dejar intermediateEvents sin incoming — siempre debe haber algo apuntando a ellos.

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
• ⚠️ LÍMITE ESTRICTO: Máximo 7 nodos por lane. CONTAR los nodos antes de escribir cada lane.
  Si un lane tiene 8 pasos → dividir en "Sección - Parte 1" (nodos 1-7) y "Sección - Parte 2" (nodo 8+).
  Si Parte 2 tiene >7 → crear "Parte 3". Ejemplo: 10 nodos = Parte 1 (7) + Parte 2 (3).
  NUNCA escribir un lane con más de 7 nodos. Verificar CADA lane antes de cerrar el JSON.
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

// Manejo de errores de multer (archivos muy grandes, tipo incorrecto)
function multerErrorHandler(err, req, res, next) {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'El archivo es demasiado grande. Máximo 50 MB.' });
    }
    if (err) {
        return res.status(400).json({ error: err.message || 'Error al procesar el archivo.' });
    }
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

        // ── Extraer texto del PDF ─────────────────────────────────────────
        let pdfData;
        try {
            pdfData = await pdf(req.file.buffer, { max: 0 });  // max:0 = todas las páginas
        } catch (pdfErr) {
            console.error('Error al parsear PDF:', pdfErr.message);
            return res.status(400).json({ error: 'No se pudo leer el PDF. Verifica que no esté protegido o corrupto.' });
        }

        const rawText    = pdfData.text.replace(/\s+/g, ' ').trim();
        const manualText = rawText.substring(0, CONFIG.maxPdfChars);

        if (manualText.length < 100) {
            return res.status(400).json({ error: 'El PDF no contiene texto extraíble. Puede ser un PDF de imágenes (escaneado).' });
        }

        // ── Subir PDF a Gemini File API para archivos grandes ────────────────
        // La File API acepta hasta 50 MB y permite que Gemini lea el PDF directamente
        // con OCR nativo — mucho mejor que extraer texto con pdf-parse (que pierde tablas,
        // imágenes, columnas, etc.). Lo usamos siempre que el archivo > 500 KB.
        let geminiFileUri = null;
        const USE_FILE_API = req.file.size > 500 * 1024;  // >500 KB → File API

        if (USE_FILE_API) {
            try {
                console.log(`PDF grande (${(req.file.size/1024/1024).toFixed(1)} MB) — subiendo a Gemini File API...`);
                // Subir usando fetch a la File API de Gemini
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
                    const errText = await uploadRes.text();
                    console.warn(`File API falló (${uploadRes.status}): ${errText} — usando texto extraído`);
                }
            } catch (fileApiErr) {
                console.warn(`File API error: ${fileApiErr.message} — usando texto extraído`);
            }
        }

        console.log(`PDF: ${req.file.size} bytes, ${pdfData.numpages} páginas, ${rawText.length} chars extraídos${geminiFileUri ? ' + File API' : ` → usando ${manualText.length} chars`}`);
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

        // ── Llamada a Gemini — con File API o texto plano ────────────────
        async function callGemini(promptText) {
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    console.log(`Llamando a Gemini (intento ${attempt + 1}/4)...`);
                    let result;
                    if (geminiFileUri) {
                        // File API: enviar el PDF como parte del contenido
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

        // FIX 0: AUTO-SPLIT lanes con > 7 nodos LINEALES
        // Solo divide lanes donde los nodos son genuinamente secuenciales (sin ciclos internos).
        // Si un lane tiene ciclos (gateway con rama de error hacia atrás), NO lo divide —
        // dividirlo rompería el ciclo. Solo divide lanes que son puramente lineales.
        {
            const MAX_LANE_NODES = 7;
            const bridgeIds = new Set();
            let pass = 0, changed = true;

            while (changed && pass < 10) {
                changed = false; pass++;
                const newRoles = [], newSteps = [];

                structure.roles.forEach(role => {
                    const laneSteps = structure.steps.filter(s => s.role === role);
                    const realCount = laneSteps.filter(s => !bridgeIds.has(s.id)).length;

                    if (realCount <= MAX_LANE_NODES) {
                        newRoles.push(role); laneSteps.forEach(s => newSteps.push(s)); return;
                    }

                    // Detectar ciclos internos — si hay un backward edge, no dividir
                    const laneIds = new Set(laneSteps.map(s => s.id));
                    const laneIdxMap = {};
                    laneSteps.forEach((s, i) => { laneIdxMap[s.id] = i; });
                    let hasCycle = false;
                    laneSteps.forEach(s => {
                        (s.next || []).forEach(nid => {
                            if (laneIds.has(nid) && (laneIdxMap[nid] < laneIdxMap[s.id])) {
                                hasCycle = true;
                            }
                        });
                    });

                    if (hasCycle) {
                        // No dividir — lane con ciclo (gateway error→retry): dejar como está
                        newRoles.push(role); laneSteps.forEach(s => newSteps.push(s)); return;
                    }

                    // Lane lineal con >7 nodos: dividir
                    changed = true;
                    const base = role.replace(/\s*-\s*Parte\s*[\d\.]+$/i, '').trim();
                    // Usar el índice global del rol para garantizar nombres únicos
                    const roleIdx = structure.roles.indexOf(role);
                    const p1n = `${base} - Parte ${roleIdx}.1`;
                    const p2n = `${base} - Parte ${roleIdx}.2`;
                    const p1s = laneSteps.slice(0, MAX_LANE_NODES);
                    const p2s = laneSteps.slice(MAX_LANE_NODES);

                    const safeBase = base.replace(/[^a-zA-Z0-9]/g, '').substring(0, 16);
                    const bid = `EvtBr_${safeBase}_${pass}`;
                    bridgeIds.add(bid);

                    const bridge = { id: bid, name: `Continuar ${base.split(' ').slice(-2).join(' ')}`,
                        type: 'intermediateEvent', role: p2n, next: [p2s[0].id] };

                    const last = p1s[p1s.length - 1];
                    if (last.type?.startsWith('endEvent') && !(last.next || []).length) {
                        last.type = 'intermediateEvent'; last.next = [bid];
                    } else if (!last.type?.startsWith('endEvent') && !(last.next || []).includes(bid)) {
                        last.next = [...(last.next || []), bid];
                    }

                    p1s.forEach(s => { s.role = p1n; }); p2s.forEach(s => { s.role = p2n; });
                    newRoles.push(p1n, p2n);
                    p1s.forEach(s => newSteps.push(s)); newSteps.push(bridge); p2s.forEach(s => newSteps.push(s));

                    console.warn(`FIX0: "${role}" (${realCount}) → "${p1n}" (${p1s.length}) + "${p2n}" (${p2s.length})`);
                });

                if (changed) { structure.roles = newRoles; structure.steps = newSteps; }
            }
        }

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
        // Regla: el flujo va izquierda→derecha dentro del lane, y SOLO baja
        // al siguiente lane cuando el proceso continúa ahí.
        // Si una sección termina → endEvent. Solo conectar hacia abajo si hay continuación.
        //
        // CASOS:
        //   A) Lane tiene orphan intermediateEvent + un endEvent en el mismo lane
        //      → el endEvent (terminal) se convierte en intermediate y conecta al orphan
        //      → PATRÓN "Parte X.2": el flujo continúa dentro del mismo lane horizontal
        //
        //   B) Orphan es el PRIMER nodo del lane (intermediateEvent de inicio de módulo)
        //      → intentar conectar desde hub del menú
        //      → fallback: conectar desde último nodo no-endEvent del lane anterior
        //
        //   C) startEvent huérfano en lane > 0 → convertir a intermediateEvent primero
        //
        // NUNCA: convertir endEvent → userTask, ni crear conexiones cross-pool.
        {
            const allTargets = new Set(structure.steps.flatMap(s => s.next || []));
            // Hub de módulos: nodo con múltiples salidas (típicamente el menú)
            const hub = structure.steps.find(s =>
                s.type === 'intermediateEvent' && (s.next || []).length > 1
            );

            structure.roles.forEach((role, ri) => {
                if (ri === 0) return; // primer lane: startEvent no necesita incoming

                const laneSteps = structure.steps.filter(s => s.role === role);
                if (!laneSteps.length) return;

                // Recalcular allTargets en cada iteración (puede haber cambiado)
                const currentTargets = new Set(structure.steps.flatMap(s => s.next || []));

                // Encuentra todos los huérfanos del lane (no solo el primero)
                const orphans = laneSteps.filter(s => !currentTargets.has(s.id));
                if (!orphans.length) return;

                orphans.forEach(orphan => {
                    // Ya tiene incoming (puede haber sido conectado en iteración anterior)
                    const updatedTargets = new Set(structure.steps.flatMap(s => s.next || []));
                    if (updatedTargets.has(orphan.id)) return;

                    // Convertir startEvent huérfano a intermediateEvent
                    if (orphan.type === 'startEvent') {
                        orphan.type = 'intermediateEvent';
                        console.warn(`FIX5: startEvent huérfano "${orphan.id}" → intermediateEvent`);
                    }

                    // CASO A: hay un endEvent en el mismo lane que no tiene salida
                    // → ese endEvent debe convertirse en intermediate y conectar al orphan
                    // (patrón "Parte X.2": flujo continúa en el mismo lane)
                    const samelaneFinalizer = laneSteps.find(s =>
                        s !== orphan &&
                        s.type?.startsWith('endEvent') &&
                        !(s.next || []).length &&
                        !updatedTargets.has(orphan.id)
                    );
                    if (samelaneFinalizer && orphan.type === 'intermediateEvent') {
                        samelaneFinalizer.type = 'intermediateEvent';
                        samelaneFinalizer.next = [orphan.id];
                        console.warn(`FIX5A: "${samelaneFinalizer.id}" endEvent→intermediate, → "${orphan.id}" (Parte X.2)`);
                        return;
                    }

                    // CASO B: orphan es intermediateEvent de inicio de módulo
                    // → conectar desde hub (menú)
                    if (hub && !hub.next.includes(orphan.id) && orphan.type === 'intermediateEvent') {
                        hub.next.push(orphan.id);
                        console.warn(`FIX5B: hub "${hub.id}" → "${orphan.id}"`);
                        return;
                    }

                    // CASO C: fallback — conectar desde el último nodo no-endEvent del lane anterior
                    if (ri > 0) {
                        const prevLane = structure.steps.filter(s => s.role === structure.roles[ri - 1]);
                        const connector = [...prevLane].reverse().find(s => !s.type?.startsWith('endEvent'));
                        if (connector && !connector.next.includes(orphan.id)) {
                            connector.next.push(orphan.id);
                            console.warn(`FIX5C: "${connector.id}" → "${orphan.id}" (lane ${ri-1}→${ri})`);
                        }
                    }
                });
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

        // FIX 8: Evt_Volver* huérfanos — conectar desde endEvent del mismo lane.
        {
            const allTargets8 = new Set(structure.steps.flatMap(s => s.next || []));
            structure.steps.forEach(volver => {
                if (!volver.id.toLowerCase().includes('volver')) return;
                if (allTargets8.has(volver.id)) return;
                const sameEnd = structure.steps.find(s =>
                    s.role === volver.role && s.type?.startsWith('endEvent')
                );
                if (sameEnd) {
                    console.warn(`FIX8: "${sameEnd.id}" → intermediateEvent → "${volver.id}"`);
                    sameEnd.type = 'intermediateEvent';
                    sameEnd.next = [volver.id];
                    allTargets8.add(volver.id);
                }
            });
        }

        // FIX 9: garantizar startEvent en CADA pool / proceso.
        // Gemini frecuentemente genera el inicio de Brigadista (o cualquier segundo pool)
        // como intermediateCatchEvent. Este fix actúa por pool:
        //   – Detecta si hay startEvent en la primera lane del pool
        //   – Si no: convierte el primer nodo (sin incoming) a startEvent
        //   – Elimina cualquier incoming cross-pool hacia ese nodo
        {
            // Detectar pools: grupos de roles antes/después del splitIdx
            // Para ser agnóstico del split, trabajamos sobre todos los roles agrupados
            // por el prefijo "Ciudadano" / "Brigadista" — o simplemente el primer nodo
            // sin incoming de CADA lane-0.
            //
            // Estrategia: para cada rol que es el primero de su "grupo" (rol index 0
            // o primer rol después de splitIdx), asegurar que su primer nodo sea startEvent.

            const poolBoundaries = [0];  // índices en allRoles donde empieza cada pool
            // Detectar el splitIdx de forma anticipada (antes del split real más abajo)
            for (let i = 1; i < structure.roles.length; i++) {
                const hasBrig = structure.roles[i].toLowerCase().includes('brigadista');
                const prevCiu = !structure.roles[i-1].toLowerCase().includes('brigadista');
                if (hasBrig && prevCiu) { poolBoundaries.push(i); break; }
            }

            poolBoundaries.forEach(boundary => {
                const firstRole = structure.roles[boundary];
                if (!firstRole) return;
                const poolRoles = structure.roles.slice(boundary,
                    poolBoundaries[poolBoundaries.indexOf(boundary)+1] ?? structure.roles.length);
                const poolSteps = structure.steps.filter(s => poolRoles.includes(s.role));
                const hasStart  = poolSteps.some(s => s.type === 'startEvent');

                if (!hasStart) {
                    // Encontrar el primer nodo del pool que no tiene incoming DENTRO del pool
                    const poolIds  = new Set(poolSteps.map(s => s.id));
                    const targets  = new Set(poolSteps.flatMap(s => s.next || []).filter(id => poolIds.has(id)));
                    const orphan   = poolSteps.find(s => !targets.has(s.id));
                    const firstNode = orphan || poolSteps[0];

                    if (firstNode && firstNode.type !== 'startEvent') {
                        console.warn(`FIX9: "${firstNode.id}" (${firstNode.type}) → startEvent (pool boundary ${boundary})`);
                        firstNode.type = 'startEvent';
                        // Eliminar incoming cross-pool hacia este nodo
                        structure.steps.forEach(s => {
                            if (!poolRoles.includes(s.role) && (s.next || []).includes(firstNode.id)) {
                                s.next = s.next.filter(n => n !== firstNode.id);
                                console.warn(`FIX9: cross-pool eliminado: "${s.id}" → "${firstNode.id}"`);
                            }
                        });
                        // Si era intermediateEvent/intermediateCatchEvent, limpiar incoming dentro del pool también
                        // (el startEvent no debe tener incoming)
                    }
                }
            });
        }

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
            // Dos pools: Ciudadano arriba, Brigadista abajo — UN solo archivo BPMN.
            const roles1  = allRoles.slice(0, splitIdx);
            const roles2  = allRoles.slice(splitIdx);
            const steps1  = allSteps.filter(s => roles1.includes(s.role));
            const steps2  = allSteps.filter(s => roles2.includes(s.role));
            const struct1 = { roles: roles1, steps: steps1 };
            const struct2 = { roles: roles2, steps: steps2 };

            const cleanPoolName1 = roles1.some(r => r.toLowerCase().includes('ciudadano'))  ? 'Portal Ciudadano'       : 'Proceso Ciudadano';
            const cleanPoolName2 = roles2.some(r => r.toLowerCase().includes('brigadista')) ? 'Herramienta Brigadista' : 'Proceso Brigadista';

            try {
                logicXml = generateLogic(struct1, processId, '') + '\n' + generateLogic(struct2, processId2, 'B');
            } catch (e) { throw new Error(`Error en generateLogic: ${e.message}`); }

            let di1, di2;
            try {
                di1 = generateDI(struct1, processId,  { poolY: 60,                  poolId: 'Participant_1', poolName: cleanPoolName1 });
                di2 = generateDI(struct2, processId2, { poolY: 60 + di1.poolH + 60, poolId: 'Participant_2', poolName: cleanPoolName2 });
                diXml = `  <bpmndi:BPMNDiagram id="BPMNDiagram_1" name="Proceso de Negocio">
    <bpmndi:BPMNPlane id="BPMNDiagram_1_Plane" bpmnElement="Collaboration_1">
${di1.shapesXml}${di2.shapesXml}${di1.edgesXml}${di2.edgesXml}    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>`;
            } catch (e) { throw new Error(`Error en generateDI: ${e.message}`); }

            collaborationXml = `  <collaboration id="Collaboration_1">
    <participant id="Participant_1" name="${xmlEscape(cleanPoolName1)}" processRef="${processId}"/>
    <participant id="Participant_2" name="${xmlEscape(cleanPoolName2)}" processRef="${processId2}"/>
  </collaboration>`;

            console.log(`✓ Pool 1: "${cleanPoolName1}" — ${steps1.length} pasos`);
            console.log(`✓ Pool 2: "${cleanPoolName2}" — ${steps2.length} pasos`);
        } else {
            // Pool único
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

        console.log(`✓ BPMN generado — ${allSteps.length} pasos, ${allRoles.length} roles`);
        res.json({
            success: true,
            data:    mdMatch ? mdMatch[1].trim() : 'Análisis completado.',
            bpmn:    finalXml,
            bpmns:   [{ name: 'Proceso de Negocio', bpmn: finalXml }],
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
app.post('/debug', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err) return multerErrorHandler(err, req, res, next);
        next();
    });
}, async (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    try {
        if (!req.file) return res.status(400).send('ERROR: Archivo no recibido.');

        let pdfData;
        try {
            pdfData = await pdf(req.file.buffer, { max: 0 });
        } catch (pdfErr) {
            return res.status(400).send(`ERROR: No se pudo leer el PDF — ${pdfErr.message}`);
        }

        const rawText    = pdfData.text.replace(/\s+/g, ' ').trim();
        const manualText = rawText.substring(0, CONFIG.maxPdfChars);
        if (manualText.length < 100) return res.status(400).send('ERROR: PDF sin texto extraíble (posiblemente escaneado).');

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
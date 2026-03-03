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
    maxPdfChars: 12_000,
    maxTokens:   65_536,
    temperature: 0.2,
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

    const POOL_X     = 160;
    const POOL_Y     = 60;
    const LABEL_W    = 30;
    const LANE_X     = POOL_X + LABEL_W;
    const COL_W      = 200;   // px between column centers
    const ROW_H      = 120;   // px between row centers
    const LANE_PAD   = 38;    // top+bottom padding inside each lane
    const START_CX   = LANE_X + 65; // center-x of column 0 within any lane
    const MAX_PER_ROW = 7;    // wrap to next row after this many nodes

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
    const poolW = maxContentX - POOL_X + 120;

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
                if (srcRow === tgtRow && x2 > x1) {
                    // Forward same row → straight horizontal
                    pts = [[x1, y1], [x2, y2]];
                } else if (srcRow < tgtRow && nodeLocalCol[targetId] === 0) {
                    // Wrap to next row: go right edge → drop below lane divider → come back left
                    const dropY = laneY[srcRi] + LANE_PAD + (srcRow + 1) * ROW_H + ROW_H / 2 - ROW_H / 2 - 12;
                    pts = [
                        [x1,          y1],
                        [x1 + 18,     y1],
                        [x1 + 18,     dropY],
                        [START_CX - 40, dropY],
                        [START_CX - 40, y2],
                        [x2,          y2],
                    ];
                } else if (x2 < x1) {
                    // Backward (loop) → arc above or below
                    const arcY = T(step.id) - 20;
                    pts = [
                        [x1,      y1],
                        [x1 + 15, y1],
                        [x1 + 15, arcY],
                        [x2 - 15, arcY],
                        [x2 - 15, y2],
                        [x2,      y2],
                    ];
                } else {
                    // Forward different row, non-zero target col
                    const midX = Math.round((x1 + x2) / 2);
                    pts = [[x1, y1], [midX, y1], [midX, y2], [x2, y2]];
                }
            } else {
                // ── Cross-lane ────────────────────────────────
                // Exit right side of source, travel vertically to target lane,
                // enter at the left of the target node.
                // Use a fixed "highway" x slightly past the rightmost node to avoid overlaps.
                const srcLaneRight = LANE_X + poolW - LABEL_W - 20;
                const crossX = Math.max(x1 + 10, Math.min(srcLaneRight, x2 + 10));

                pts = [
                    [x1,     y1],
                    [crossX, y1],
                    [crossX, y2],
                    [x2,     y2],
                ];
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
    return `Eres un analista de procesos BPMN experto. Analiza el manual y genera un diagrama BPMN profesional en estilo Bizagi.

CONCEPTO CLAVE — LANES = SUB-PROCESOS FUNCIONALES (no roles):
  Cada lane representa UNA SECCIÓN FUNCIONAL del proceso, siguiendo exactamente cómo
  está organizado el manual. Ejemplos reales:
    MAL (por roles):   lanes = ["Ciudadano", "Sistema", "Brigadista"]
    BIEN (funcional):  lanes = ["Inicio de sesión", "Pre-registro", "Verificar cuenta",
                                 "Menú principal", "Mis credenciales", "Unidades de salud"]
  Cada lane debe tener MÁXIMO 8 nodos para que el flujo sea legible en horizontal.
  Si una sección tiene muchos pasos, divídela en dos lanes (ej: "Registro - parte 1", "Registro - parte 2").

ORDEN LÓGICO DE LOS LANES — MUY IMPORTANTE:
  El primer lane es siempre el PUNTO DE ENTRADA del proceso (lo que el usuario hace primero).
  Sigue el orden natural del uso de la aplicación:
    1. Si hay login → el PRIMER lane es "Inicio de sesión" (con el startEvent ahí)
    2. Luego el registro o pre-registro (si aplica, como alternativa al login)
    3. Luego la verificación de cuenta (si aplica)
    4. Luego el menú principal / acceso a módulos
    5. Luego cada módulo funcional en su propio lane
    6. El último lane es siempre "Cerrar sesión"
  Si el proceso NO tiene login, el primer lane es la primera acción del usuario.

REGLAS OBLIGATORIAS:
1. UN SOLO startEvent para todo el diagrama — en el primer lane, primer nodo del array.
2. Cada lane (sub-proceso) termina con su propio endEvent o endEventMessage.
3. Los sub-procesos secundarios se conectan desde el flujo principal usando intermediateEvent, NO con startEvent separados.
4. Usa exclusiveGateway solo para bifurcaciones clave (éxito/fallo, opción A/B).
5. IDs únicos, cortos, sin espacios ni caracteres especiales.
6. NUNCA crees referencias circulares en "next" (A→B→A causa error crítico).
7. El campo "conditions" en gateways es obligatorio si hay más de una salida.
8. Todos los nodos deben estar conectados — ningún nodo sin "next" salvo endEvent/endEventMessage.
9. ORDEN del array steps[]: primero el startEvent, luego los nodos del primer lane en orden de flujo, luego los del segundo lane, etc.

TIPOS DE NODO:
  startEvent            → UN solo inicio para todo el proceso (círculo verde)
  endEvent              → Fin de una sección o del proceso completo (círculo rojo)
  endEventMessage       → Fin con confirmación al usuario — "operación exitosa" (círculo rojo con sobre)
  userTask              → Acción que realiza el usuario (persona)
  serviceTask           → Llamada a servicio externo o API (engranajes)
  scriptTask            → Validación o procesamiento interno del sistema (script)
  exclusiveGateway      → Decisión binaria o múltiple (rombo con X)
  intermediateEvent     → Marca el inicio de un módulo o sub-sección (círculo doble vacío)
  intermediateEventMessage → Envío/recepción de notificación dentro del flujo (círculo doble con sobre)

PATRÓN DEL DIAGRAMA PROFESIONAL (síguelo):
  startEvent → tarea(s) del lane 1 → endEvent/intermediateEvent de conexión
  intermediateEvent → tarea(s) del lane 2 → endEvent
  ... (un lane por cada sección funcional del manual)
  
  Cuando el proceso tiene un menú/hub central:
  intermediateEvent("Módulos") → sale hacia varios intermediateEvent de sección
  Cada sección tiene su propio endEvent

FORMATO DE RESPUESTA — responde ÚNICAMENTE con esto:

[MD_START]
**Lanes (sub-procesos):** lista de secciones funcionales identificadas
**Pasos totales:** número
**Flujo general:** descripción de 2-3 líneas del proceso
[MD_END]
[JSON_START]
{
  "roles": ["Pre-registro", "Verificar contraseña", "Inicio de sesión y menú", "Módulo A", "Módulo B"],
  "steps": [
    { "id": "Start_Proceso", "name": "Inicio del proceso", "type": "startEvent", "role": "Pre-registro", "next": ["Task_Paso1"] },
    { "id": "Task_Paso1", "name": "Completar formulario", "type": "userTask", "role": "Pre-registro", "next": ["Script_Validar"] },
    { "id": "Script_Validar", "name": "Validar datos", "type": "scriptTask", "role": "Pre-registro", "next": ["GW_Valido"] },
    { "id": "GW_Valido", "name": "¿Datos válidos?", "type": "exclusiveGateway", "role": "Pre-registro", "next": ["Evt_SiguienteLane", "Task_Error"], "conditions": {"Evt_SiguienteLane": "Sí", "Task_Error": "No"} },
    { "id": "Task_Error", "name": "Mostrar error y reintentar", "type": "userTask", "role": "Pre-registro", "next": ["Task_Paso1"] },
    { "id": "Evt_SiguienteLane", "name": "Verificación de cuenta", "type": "intermediateEvent", "role": "Verificar contraseña", "next": ["Task_IngresarCodigo"] },
    { "id": "Task_IngresarCodigo", "name": "Ingresar código recibido", "type": "userTask", "role": "Verificar contraseña", "next": ["End_Verificacion"] },
    { "id": "End_Verificacion", "name": "Verificación completa", "type": "endEventMessage", "role": "Verificar contraseña", "next": [] },
    { "id": "Evt_Login", "name": "Inicio de sesión", "type": "intermediateEvent", "role": "Inicio de sesión y menú", "next": ["Task_Credenciales"] },
    { "id": "Task_Credenciales", "name": "Ingresar credenciales", "type": "userTask", "role": "Inicio de sesión y menú", "next": ["Script_ValidarLogin"] },
    { "id": "Script_ValidarLogin", "name": "Validar credenciales", "type": "scriptTask", "role": "Inicio de sesión y menú", "next": ["GW_Login"] },
    { "id": "GW_Login", "name": "¿Login exitoso?", "type": "exclusiveGateway", "role": "Inicio de sesión y menú", "next": ["Evt_Modulos", "Task_ErrorLogin"], "conditions": {"Evt_Modulos": "Sí", "Task_ErrorLogin": "No"} },
    { "id": "Task_ErrorLogin", "name": "Mostrar error de credenciales", "type": "userTask", "role": "Inicio de sesión y menú", "next": ["Task_Credenciales"] },
    { "id": "Evt_Modulos", "name": "Módulos del sistema", "type": "intermediateEvent", "role": "Inicio de sesión y menú", "next": ["Evt_ModuloA", "Evt_ModuloB", "End_CerrarSesion"] },
    { "id": "End_CerrarSesion", "name": "Cerrar sesión", "type": "endEvent", "role": "Inicio de sesión y menú", "next": [] },
    { "id": "Evt_ModuloA", "name": "Módulo A", "type": "intermediateEvent", "role": "Módulo A", "next": ["Task_AccionA"] },
    { "id": "Task_AccionA", "name": "Realizar acción A", "type": "userTask", "role": "Módulo A", "next": ["End_ModuloA"] },
    { "id": "End_ModuloA", "name": "Operación A completada", "type": "endEventMessage", "role": "Módulo A", "next": [] },
    { "id": "Evt_ModuloB", "name": "Módulo B", "type": "intermediateEvent", "role": "Módulo B", "next": ["Task_AccionB"] },
    { "id": "Task_AccionB", "name": "Realizar acción B", "type": "userTask", "role": "Módulo B", "next": ["End_ModuloB"] },
    { "id": "End_ModuloB", "name": "Operación B completada", "type": "endEventMessage", "role": "Módulo B", "next": [] }
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

        // Extraer texto: inicio del manual (roles/contexto) + final (últimos pasos)
        const pdfData    = await pdf(req.file.buffer);
        const rawText    = pdfData.text.replace(/\s+/g, ' ').trim();
        const chunkA     = rawText.substring(0, 9_000);
        const chunkB     = rawText.substring(Math.max(0, rawText.length - 3_000));
        const manualText = (chunkA + ' [...] ' + chunkB).substring(0, CONFIG.maxPdfChars);

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
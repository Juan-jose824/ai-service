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
    maxPdfChars: 120_000,
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

function assignColumns(steps) {
    const stepMap = {}, nodeColumn = {};
    steps.forEach(s => { stepMap[s.id] = s; });
    const inDegree = {};
    steps.forEach(s => { inDegree[s.id] = 0; });
    steps.forEach(s => { (s.next || []).forEach(nid => { if (inDegree[nid] !== undefined) inDegree[nid]++; }); });
    const queue = steps.filter(s => inDegree[s.id] === 0).map(s => s.id);
    if (queue.length === 0 && steps.length > 0) queue.push(steps[0].id);
    const processed = new Set();
    steps.forEach(s => { nodeColumn[s.id] = 0; });
    while (queue.length > 0) {
        const id = queue.shift();
        if (processed.has(id)) continue;
        processed.add(id);
        const step = stepMap[id];
        if (step && step.next) {
            step.next.forEach(nextId => {
                if (!nextId || nextId === id) return;
                const newCol = (nodeColumn[id] || 0) + 1;
                if (newCol > (nodeColumn[nextId] || 0)) nodeColumn[nextId] = newCol;
                if (!processed.has(nextId)) queue.push(nextId);
            });
        }
    }
    return nodeColumn;
}

function assignRows(steps, nodeColumn, roles) {
    const laneColCount = {}, nodeRow = {};
    const sorted = [...steps].sort((a, b) => (nodeColumn[a.id] || 0) - (nodeColumn[b.id] || 0));
    sorted.forEach(step => {
        const roleIdx = roles.indexOf(step.role);
        const col = nodeColumn[step.id] || 0;
        const key = `${roleIdx}_${col}`;
        if (laneColCount[key] === undefined) laneColCount[key] = 0;
        nodeRow[step.id] = laneColCount[key];
        laneColCount[key]++;
    });
    const maxRowPerLane = {};
    roles.forEach((_, i) => { maxRowPerLane[i] = 0; });
    steps.forEach(step => {
        const roleIdx = roles.indexOf(step.role);
        const row = nodeRow[step.id] || 0;
        if (row + 1 > maxRowPerLane[roleIdx]) maxRowPerLane[roleIdx] = row + 1;
    });
    return { nodeRow, maxRowPerLane };
}

function generateLogic(structure, processId, lanePrefix = '') {
    const { roles, steps } = structure;

    // Cada pool recibe un prefijo único para sus IDs de nodos y flows.
    // Esto evita colisiones cuando múltiples pools comparten IDs como "Start_Login".
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


function generateDI(structure, processId, poolOpts = {}) {
    const { roles, steps } = structure;
    const POOL_ID   = poolOpts.poolId    ?? 'Participant_1';
    const POOL_Y    = poolOpts.poolY     ?? 60;
    const LANE_PFX  = poolOpts.lanePrefix ?? '';
    // ID prefix must match generateLogic — same formula
    const NODE_PFX  = LANE_PFX === '' ? 'p0_' : `p${LANE_PFX}_`;
    const npid      = id => `${NODE_PFX}${id}`;
    const nfid      = (s, t) => `Flow_${NODE_PFX}${s}_${NODE_PFX}${t}`;

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

    // ── Layout constants ─────────────────────────────────────────────────────
    // COL_W 320: gap visible entre tareas = 320-120 = 200px — espacioso y profesional
    // LANE_H 420: altura cómoda, nodos centrados con buen margen vertical
    const POOL_X   = 160;
    const LABEL_W  = 30;
    const LANE_X   = POOL_X + LABEL_W;      // 190
    const LANE_H   = 420;                   // altura lane fila simple
    const LANE_H_2 = 840;                   // altura lane doble fila
    const COL_W    = 320;                   // centro a centro — gap visual = 320-120 = 200px
    const MAX_COLS = 7;
    const COL0_CX  = LANE_X + 160;         // cx columna 0
    const HW_STEP  = 25;

    const stepMap = {};
    steps.forEach(s => { stepMap[s.id] = s; });

    // Topological sort per lane
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

    // Assign col/row
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

    // Lane heights & Y positions
    const laneH = {}, laneY = {};
    let curY = POOL_Y;
    roles.forEach((role, ri) => {
        laneH[ri] = laneRows[role] <= 1 ? LANE_H : LANE_H_2;
        laneY[ri] = curY;
        curY += laneH[ri];
    });
    const poolH = curY - POOL_Y;

    // Node pixel positions
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
            w, h, cx: Math.round(cx), cy: Math.round(cy),
        };
    });

    // Pool width
    const maxNodeRight = steps.reduce((m, s) => {
        const p = pos[s.id]; return p ? Math.max(m, p.x + p.w) : m;
    }, COL0_CX + (MAX_COLS - 1) * COL_W + 60);
    const HW_BASE = maxNodeRight + 60;

    // Highway tracks
    const hwMap = new Map();
    let hwIdx = 0;
    {
        const cross = [];
        steps.forEach(s => {
            const si = roles.indexOf(s.role);
            (s.next || []).forEach(tid => {
                const t = stepMap[tid];
                if (!t) return;
                const ti = roles.indexOf(t.role);
                if (ti !== si) cross.push({ src: s.id, tgt: tid, si, ti, gap: Math.abs(ti - si), col: nodeCol[s.id] ?? 0 });
            });
        });
        cross.sort((a, b) => b.gap - a.gap || a.si - b.si || a.col - b.col);
        cross.forEach(e => {
            const key = `${e.src}->${e.tgt}`;
            if (!hwMap.has(key)) { hwMap.set(key, HW_BASE + hwIdx * HW_STEP); hwIdx++; }
        });
    }

    const poolW = Math.max(2000, HW_BASE + hwIdx * HW_STEP + 80);

    const P   = id => pos[id];
    const R   = id => P(id).x + P(id).w;
    const L   = id => P(id).x;
    const CX  = id => P(id).cx;
    const CY  = id => P(id).cy;
    const wpt = pts => pts.map(([x, y]) => `        <di:waypoint x="${Math.round(x)}" y="${Math.round(y)}"/>`).join('\n');

    // Shapes
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

    // Edges
    let edges = '';
    steps.forEach(step => {
        if (!P(step.id)) return;
        const srcRi = roles.indexOf(step.role);
        (step.next || []).forEach(targetId => {
            if (!P(targetId)) return;
            const tgtRi  = roles.indexOf(stepMap[targetId]?.role);
            const edgeId = `Edge_${npid(step.id)}_${npid(targetId)}`;
            const flowId = nfid(step.id, targetId);
            let pts;

            if (srcRi === tgtRi) {
                // ── Same lane ─────────────────────────────────
                const srcRow = nodeRow[step.id] ?? 0;
                const tgtRow = nodeRow[targetId] ?? 0;
                if (srcRow < tgtRow) {
                    // Wrap to next row inside same lane
                    const wrapX   = HW_BASE - 40 + srcRi * 4;
                    const returnX = LANE_X + 10 + srcRi * 4;
                    const midY    = laneY[srcRi] + (srcRow + 1) * LANE_H - 15;
                    pts = [
                        [R(step.id),  CY(step.id)],
                        [wrapX,       CY(step.id)],
                        [wrapX,       midY],
                        [returnX,     midY],
                        [returnX,     CY(targetId)],
                        [L(targetId), CY(targetId)],
                    ];
                } else if (CX(targetId) <= CX(step.id)) {
                    // Backward arc — above lane top
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
                    // Simple forward
                    pts = [[R(step.id), CY(step.id)], [L(targetId), CY(targetId)]];
                }
            } else {
                // ── Cross-lane routing ─────────────────────────
                // Estilo Bizagi profesional (igual al diagrama de referencia salud.bpmn):
                //   Cada flecha usa un X ligeramente distinto para no apilarse.
                //   Sale por la parte inferior del nodo fuente, baja hasta el espacio
                //   entre lanes, gira horizontal al X del destino, entra por arriba.
                //   Funciona tanto hacia adelante como hacia atrás.
                const outIdx   = (step.next || []).indexOf(targetId);
                const outCount = (step.next || []).length;
                const spread   = Math.min(outCount - 1, 6) * 18;
                const offset   = outCount > 1
                    ? -spread / 2 + outIdx * (spread / Math.max(outCount - 1, 1))
                    : 0;

                const srcCX     = CX(step.id) + offset;
                const tgtCX     = CX(targetId);
                const srcBottom = P(step.id).y + P(step.id).h;
                const tgtTop    = P(targetId).y;

                if (Math.abs(srcCX - tgtCX) < 5) {
                    pts = [
                        [srcCX, srcBottom],
                        [srcCX, tgtTop],
                    ];
                } else {
                    const midY = (laneY[srcRi] + laneH[srcRi] + laneY[tgtRi]) / 2;
                    pts = [
                        [srcCX, srcBottom],
                        [srcCX, midY],
                        [tgtCX, midY],
                        [tgtCX, tgtTop],
                    ];
                }
            }

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

function buildPrompt(text) {
    return `Eres un analista de procesos BPMN experto. Tu objetivo es generar diagramas claros, concisos y profesionales — listos para ser presentados a un director de área sin explicación adicional.

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
                    console.warn(`File API falló (${uploadRes.status}) — usando texto extraído`);
                }
            } catch (e) {
                console.warn(`File API error: ${e.message} — usando texto extraído`);
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

        // Si Gemini devolvió pools[] pero no roles[] al nivel raíz, derivar roles de pools
        if (!structure.roles?.length && structure.pools?.length) {
            structure.roles = structure.pools.flatMap(p => p.roles || []);
            console.log('roles derivados de pools[]: ' + structure.roles.length + ' roles');
        }
        if (!structure.roles?.length || !structure.steps?.length) throw new Error('Sin roles o pasos válidos.');

        const validIds = new Set(structure.steps.map(s => s.id));

        // PRE-FIX: Cuando Gemini usa el mismo nombre de lane en múltiples pools
        // (ej: "Inicio de sesión" en Pool Ciudadano Y Pool Brigadista),
        // structure.roles tiene ese nombre duplicado.
        // Solución: renombrar con sufijo de pool para que sean únicos.
        // Los pasos del primer pool que use ese nombre conservan el role original renombrado.
        // Los pools siguientes reciben un startEvent mínimo via FIX9.
        if (structure.pools?.length > 1) {
            // Construir mapa: roleName → [poolIndex, ...]
            const rolePoolIdx = {};
            structure.pools.forEach((pool, pi) => {
                (pool.roles || []).forEach(r => {
                    if (!rolePoolIdx[r]) rolePoolIdx[r] = [];
                    rolePoolIdx[r].push(pi);
                });
            });
            // Para cada role que aparece en >1 pool, renombrar
            Object.entries(rolePoolIdx).forEach(([r, pis]) => {
                if (pis.length < 2) return;
                pis.forEach((pi, occurrence) => {
                    const newName = r + ' · ' + (pi + 1);
                    structure.pools[pi].roles = structure.pools[pi].roles.map(x => x === r ? newName : x);
                    if (occurrence === 0) {
                        // Primer pool: reasignar pasos existentes
                        structure.steps.forEach(s => { if (s.role === r) s.role = newName; });
                        console.warn(`PRE-FIX: "${r}" → "${newName}" (pool ${pi})`);
                    } else {
                        // Pools siguientes: no tienen pasos propios para ese role — FIX9 se encarga
                        console.warn(`PRE-FIX: pool ${pi} reclama "${r}" → "${newName}" (sin pasos, FIX9 lo maneja)`);
                    }
                });
            });
            // Reconstruir structure.roles desde pools actualizados
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
                // Deduplicar structure.steps por ID antes de procesar
                // Evita multiplicación exponencial si hay roles duplicados
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
                    // roleIdx ya viene del forEach — único por posición, evita colisiones con nombres iguales
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
                    // Sincronizar structure.pools con los nuevos nombres de roles.
                    // FIX0 renombra 'Pre-registro' → 'Pre-registro - Parte 1.1' + 'Pre-registro - Parte 1.2'
                    // Sin esto, pools[i].roles sigue con el nombre viejo → lanes vacíos en el pool correcto
                    // y nodos cayendo en el pool equivocado.
                    if (structure.pools?.length) {
                        structure.pools.forEach(pool => {
                            const updated = [];
                            pool.roles.forEach(origRole => {
                                // Buscar si este rol fue dividido en partes
                                const replacements = newRoles.filter(nr =>
                                    nr === origRole ||                          // sin cambio
                                    nr.startsWith(origRole + ' - Parte ')       // fue dividido
                                );
                                if (replacements.length) updated.push(...replacements);
                                else updated.push(origRole); // rol que no existe más — se limpiará en FIX3
                            });
                            pool.roles = [...new Set(updated)]; // deduplicar por si acaso
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

        // FIX 9: garantizar startEvent en cada pool definido por Gemini
        // Funciona con cualquier número de pools (1, 2, 3, N)
        {
            const poolDefs = structure.pools || null;
            // Construir lista de grupos de roles por pool
            const poolGroups = poolDefs
                ? poolDefs.map(p => ({ name: p.name, roles: p.roles }))
                : [{ name: null, roles: structure.roles }]; // fallback: todo en un pool

            poolGroups.forEach(({ name, roles: poolRoles }) => {
                const poolSteps = structure.steps.filter(s => poolRoles.includes(s.role));
                if (!poolSteps.length) return;
                if (poolSteps.some(s => s.type === 'startEvent')) return;
                const poolIds = new Set(poolSteps.map(s => s.id));
                const targets = new Set(poolSteps.flatMap(s => s.next || []).filter(id => poolIds.has(id)));
                const firstNode = poolSteps.find(s => !targets.has(s.id)) || poolSteps[0];
                if (firstNode && firstNode.type !== 'startEvent') {
                    // Si ya hay un startEvent en este pool, promover a intermediateEvent (no startEvent)
                    // Esto evita que FIX9 cree un startEvent en "Cerrar sesión" cuando el pool
                    // ya tiene su startEvent correcto en "Inicio de sesión"
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

        // FIX 10: eliminar intermediateEvents "relay" redundantes
        // Un intermediateEvent con exactamente 1 entrada cross-lane y 1 salida es
        // simplemente un conector de apariencia — no aporta información al diagrama.
        // Lo eliminamos y conectamos directamente el nodo previo con el siguiente.
        // EXCEPCIÓN: hubs (>1 salida), bridges de FIX0, y eventos con nombre informativo
        {
            const bridgePattern = /^EvtBr_/;
            let removed = true;
            while (removed) {
                removed = false;
                const toRemove = new Set();
                const stepMap = {};
                structure.steps.forEach(s => { stepMap[s.id] = s; });

                structure.steps.forEach(step => {
                    if (step.type !== 'intermediateEvent' && step.type !== 'intermediateEventMessage') return;
                    if (bridgePattern.test(step.id)) return; // FIX0 bridge — mantener
                    const outs = step.next || [];
                    if (outs.length !== 1) return; // hub o sin salida — mantener
                    // Buscar todos los que apuntan a este evento
                    const ins = structure.steps.filter(s => (s.next || []).includes(step.id));
                    if (ins.length !== 1) return; // 0 o múltiples entradas — mantener
                    const src = ins[0];
                    const tgt = outs[0];
                    // Solo eliminar si la entrada viene de un lane distinto (cross-lane relay)
                    if (src.role === step.role) return; // misma lane — es un connector interno, mantener
                    // Reconectar src → tgt directamente
                    src.next = src.next.map(n => n === step.id ? tgt : n);
                    // Transferir condición si existe
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
                    // Actualizar pools también
                    if (structure.pools) {
                        structure.pools.forEach(pool => {
                            pool.roles = pool.roles.filter(r => structure.steps.some(s => s.role === r));
                        });
                    }
                }
            }
        }

        // ─── ENSAMBLADO GENÉRICO DE N POOLS ──────────────────────────────────────
        // Si Gemini devolvió pools[] → usamos esa definición directamente.
        // Si no → todo en un solo pool (compatibilidad hacia atrás).
        {
            const allSteps = structure.steps;
            const ts = Date.now();

            // Construir definición de pools
            let poolDefs;
            if (structure.pools?.length) {
                // Normalizar: asegurarse que cada role mencionado en steps esté en algún pool
                const assignedRoles = new Set(structure.pools.flatMap(p => p.roles));
                const unassigned = structure.roles.filter(r => !assignedRoles.has(r));
                if (unassigned.length) {
                    // Agregar roles huérfanos al último pool
                    structure.pools[structure.pools.length - 1].roles.push(...unassigned);
                    console.warn(`FIX: ${unassigned.length} roles sin pool → agregados al último`);
                }
                poolDefs = structure.pools;
            } else {
                // Fallback: todo en un pool genérico
                poolDefs = [{ name: 'Proceso de Negocio', roles: structure.roles }];
            }

            // Generar un processId y lane prefix por pool
            const poolConfigs = poolDefs.map((pool, i) => ({
                name:      pool.name || `Proceso ${i + 1}`,
                roles:     pool.roles,
                steps:     allSteps.filter(s => pool.roles.includes(s.role)),
                processId: `Process_${ts + i}`,
                poolId:    `Participant_${i + 1}`,
                lanePrefix: i === 0 ? '' : String.fromCharCode(65 + i - 1), // '', 'A', 'B', 'C'...
            }));

            // Generar XML de lógica (procesos BPMN) para cada pool
            const logicXml = poolConfigs
                .map(pc => generateLogic({ roles: pc.roles, steps: pc.steps }, pc.processId, pc.lanePrefix))
                .join('\n');

            // Generar DI (shapes + edges) apilando pools verticalmente
            let currentY = 60;
            const diParts = [];
            poolConfigs.forEach(pc => {
                const di = generateDI(
                    { roles: pc.roles, steps: pc.steps },
                    pc.processId,
                    { poolY: currentY, poolId: pc.poolId, poolName: pc.name, lanePrefix: pc.lanePrefix }
                );
                diParts.push(di);
                currentY += di.poolH + 60; // 60px gap entre pools
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
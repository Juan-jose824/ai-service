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
    maxTokens:   65_536,   // subido: 144 pasos necesitan ~30k tokens de salida
    temperature: 0.2,
    timeout:     120_000,
};

// ==========================================
// 1. GENERADOR DE LÓGICA BPMN (XML)
// ==========================================
function generateLogic(structure, processId) {
    const lanes = structure.roles.map((role, idx) => {
        const refs = structure.steps
            .filter(s => s.role === role)
            .map(s => `        <flowNodeRef>${s.id}</flowNodeRef>`)
            .join('\n');
        return `      <lane id="Lane_${idx}" name="${role}">\n${refs}\n      </lane>`;
    }).join('\n');

    const tasks = structure.steps.map(step => {
        const tag      = step.type || 'task';
        const outgoing = (step.next || [])
            .map(t => `      <outgoing>Flow_${step.id}_${t}</outgoing>`)
            .join('\n');
        const incoming = structure.steps
            .filter(s => (s.next || []).includes(step.id))
            .map(s => `      <incoming>Flow_${s.id}_${step.id}</incoming>`)
            .join('\n');
        const safeName = (step.name || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        return `    <${tag} id="${step.id}" name="${safeName}">\n${incoming}\n${outgoing}\n    </${tag}>`;
    }).join('\n');

    const sequences = structure.steps.flatMap(step =>
        (step.next || []).map(targetId => {
            const cond = step.conditions?.[targetId]
                ? ` name="${step.conditions[targetId].replace(/&/g, '&amp;')}"`
                : '';
            return `    <sequenceFlow id="Flow_${step.id}_${targetId}" sourceRef="${step.id}" targetRef="${targetId}"${cond}/>`;
        })
    ).join('\n');

    return `
  <process id="${processId}" isExecutable="false">
    <laneSet id="LaneSet_1">
${lanes}
    </laneSet>
${tasks}
${sequences}
  </process>`;
}

// ==========================================
// 2. GENERADOR DE COORDENADAS (BPMN DI)
// ==========================================
function generateDI(structure, processId) {
    const LANE_H  = 180;
    const POOL_X  = 160;
    const POOL_Y  = 80;
    const LABEL_W = 30;
    const COL_W   = 240;
    const START_X = POOL_X + LABEL_W + 60;

    const NODE_SIZE = {
        startEvent:       { w: 36,  h: 36 },
        endEvent:         { w: 36,  h: 36 },
        exclusiveGateway: { w: 50,  h: 50 },
        task:             { w: 120, h: 80 },
        userTask:         { w: 120, h: 80 },
        serviceTask:      { w: 120, h: 80 },
    };

    // ── BFS ITERATIVO ───────────────────────────────────────────────────────
    // Reemplaza la versión recursiva que causaba "Maximum call stack size
    // exceeded" cuando Gemini devolvía ciclos en el JSON (A→B→A).
    const nodeColumn = {};
    const stepMap    = {};
    structure.steps.forEach(s => { stepMap[s.id] = s; });

    const hasIncoming = new Set();
    structure.steps.forEach(s => (s.next || []).forEach(id => hasIncoming.add(id)));
    const roots = structure.steps.filter(s => !hasIncoming.has(s.id));
    if (roots.length === 0 && structure.steps.length > 0) roots.push(structure.steps[0]);

    const queue   = roots.map(s => ({ id: s.id, col: 0 }));

    while (queue.length > 0) {
        const { id, col } = queue.shift();
        // Si ya asignamos columna >= a esta, cortar (evita ciclos infinitos)
        if (nodeColumn[id] !== undefined && nodeColumn[id] >= col) continue;
        nodeColumn[id] = col;
        const step = stepMap[id];
        if (step && step.next) {
            step.next.forEach(nextId => {
                if (nextId !== id) queue.push({ id: nextId, col: col + 1 });
            });
        }
    }

    // Nodos huérfanos que BFS no alcanzó (ciclos puros)
    structure.steps.forEach((s, i) => {
        if (nodeColumn[s.id] === undefined) nodeColumn[s.id] = i;
    });
    // ────────────────────────────────────────────────────────────────────────

    const roleY = {};
    structure.roles.forEach((role, i) => { roleY[role] = POOL_Y + i * LANE_H; });

    const positions = {};
    structure.steps.forEach(step => {
        const size  = NODE_SIZE[step.type] || NODE_SIZE.task;
        const col   = nodeColumn[step.id] || 0;
        const laneY = roleY[step.role] !== undefined ? roleY[step.role] : POOL_Y;
        positions[step.id] = {
            x: START_X + col * COL_W,
            y: laneY + (LANE_H - size.h) / 2,
            w: size.w,
            h: size.h,
        };
    });

    const maxCol = Math.max(...Object.values(nodeColumn), 0);
    const poolW  = (maxCol + 1) * COL_W + 200;
    const poolH  = structure.roles.length * LANE_H;

    // Pool
    let shapes = `      <bpmndi:BPMNShape id="Participant_1_di" bpmnElement="Participant_1" isHorizontal="true">
        <dc:Bounds x="${POOL_X}" y="${POOL_Y}" width="${poolW}" height="${poolH}"/>
      </bpmndi:BPMNShape>\n`;

    // Lanes
    structure.roles.forEach((role, i) => {
        shapes += `      <bpmndi:BPMNShape id="Lane_${i}_di" bpmnElement="Lane_${i}" isHorizontal="true">
        <dc:Bounds x="${POOL_X + LABEL_W}" y="${roleY[role]}" width="${poolW - LABEL_W}" height="${LANE_H}"/>
      </bpmndi:BPMNShape>\n`;
    });

    // Nodos
    structure.steps.forEach(step => {
        const p = positions[step.id];
        if (!p) return;
        shapes += `      <bpmndi:BPMNShape id="Shape_${step.id}" bpmnElement="${step.id}">
        <dc:Bounds x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>
      </bpmndi:BPMNShape>\n`;
    });

    // Edges
    let edges = '';
    structure.steps.forEach(step => {
        const src = positions[step.id];
        if (!src) return;
        (step.next || []).forEach(targetId => {
            const tgt = positions[targetId];
            if (!tgt) return;
            const x1   = src.x + src.w;
            const y1   = src.y + src.h / 2;
            const x2   = tgt.x;
            const y2   = tgt.y + tgt.h / 2;
            const midX = Math.round(x1 + (x2 - x1) / 2);
            edges += `      <bpmndi:BPMNEdge id="Edge_${step.id}_${targetId}" bpmnElement="Flow_${step.id}_${targetId}">
        <di:waypoint x="${x1}" y="${y1}"/>
        <di:waypoint x="${midX}" y="${y1}"/>
        <di:waypoint x="${midX}" y="${y2}"/>
        <di:waypoint x="${x2}" y="${y2}"/>
      </bpmndi:BPMNEdge>\n`;
        });
    });

    return `  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">
${shapes}${edges}    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>`;
}

// ==========================================
// 3. PROMPT
// ==========================================
function buildPrompt(text) {
    return `Eres un analista de procesos BPMN. Analiza el manual y devuelve el proceso en JSON.

REGLAS:
- Identifica TODOS los roles que interactúan (Ciudadano, Sistema, Brigadista, Coordinador, etc.).
- MÁXIMO 50 pasos en total. Agrupa acciones menores en una sola tarea con nombre descriptivo.
  Ejemplo: en vez de 5 pasos de "llenar campo X", usa 1 tarea "Completar formulario de registro".
- Usa "exclusiveGateway" SOLO para decisiones clave del proceso (no para cada validación menor).
- "startEvent" al inicio de cada flujo principal, "endEvent" al final.
- El campo "next" contiene los IDs siguientes. NUNCA crees ciclos directos (A→B→A).
- Los IDs deben ser únicos, cortos y sin espacios (ej: Task_Login, GW_CURPValida).
- El campo "conditions" es opcional: para gateways indica la etiqueta de cada salida.

RESPONDE SOLO con este formato exacto, sin texto adicional fuera de las etiquetas:

[MD_START]
Resumen breve: roles encontrados y número de pasos.
[MD_END]
[JSON_START]
{
  "roles": ["Rol A", "Rol B"],
  "steps": [
    { "id": "Start_1",  "name": "Inicio",           "type": "startEvent",       "role": "Rol A", "next": ["Task_1"] },
    { "id": "Task_1",   "name": "Ejecutar acción",   "type": "userTask",         "role": "Rol A", "next": ["GW_1"] },
    { "id": "GW_1",     "name": "¿Es válido?",       "type": "exclusiveGateway", "role": "Rol A", "next": ["Task_2", "Task_1"], "conditions": {"Task_2": "Sí", "Task_1": "No"} },
    { "id": "Task_2",   "name": "Procesar",          "type": "serviceTask",      "role": "Rol B", "next": ["End_1"] },
    { "id": "End_1",    "name": "Fin",               "type": "endEvent",         "role": "Rol B", "next": [] }
  ]
}
[JSON_END]

MANUAL:
${text}`;
}

// ==========================================
// 4. ENDPOINT PRINCIPAL
// ==========================================
app.post('/analyze', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Archivo no recibido.' });

        const pdfData    = await pdf(req.file.buffer);
        const rawText    = pdfData.text.replace(/\s+/g, ' ').trim();
        const chunkA     = rawText.substring(0, 9_000);
        const chunkB     = rawText.substring(Math.max(0, rawText.length - 3_000));
        const manualText = (chunkA + ' ... ' + chunkB).substring(0, CONFIG.maxPdfChars);

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

        const mdMatch   = responseText.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);
        const jsonMatch = responseText.match(/\[JSON_START\]([\s\S]*?)\[JSON_END\]/);

        // ── Extracción robusta: maneja respuestas truncadas ──────────────────
        let rawJson = null;
        if (jsonMatch) {
            // Caso ideal: respuesta completa con ambas etiquetas
            rawJson = jsonMatch[1];
        } else {
            // Caso de respuesta truncada: buscar desde [JSON_START] hasta el final
            const partialMatch = responseText.match(/\[JSON_START\]([\s\S]*)/);
            if (partialMatch) {
                console.warn('JSON truncado — intentando reparar respuesta cortada...');
                rawJson = partialMatch[1];
            }
        }

        if (!rawJson) {
            console.error('Respuesta sin JSON:', responseText.substring(0, 400));
            throw new Error('Gemini no devolvió JSON. Intenta de nuevo o usa un PDF más corto.');
        }

        let structure;
        try {
            let jsonStr = rawJson.replace(/```json|```/g, '').trim();

            // Si está truncado, cerrar el JSON en el último objeto completo
            if (!jsonStr.trimEnd().endsWith('}')) {
                const lastBrace = jsonStr.lastIndexOf('}');
                if (lastBrace > 0) {
                    jsonStr = jsonStr.substring(0, lastBrace + 1) + '\n  ]\n}';
                    console.warn('JSON reparado automáticamente.');
                }
            }

            structure = JSON.parse(jsonStr);
        } catch (e) {
            throw new Error(`JSON inválido en respuesta de Gemini: ${e.message}`);
        }

        if (!structure.roles?.length || !structure.steps?.length) {
            throw new Error('La respuesta de Gemini no contiene roles o pasos válidos.');
        }

        const processId = `Process_${Date.now()}`;
        const finalXml  = `<?xml version="1.0" encoding="utf-8"?>
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
${generateLogic(structure, processId)}
${generateDI(structure, processId)}
</definitions>`;

        console.log(`✓ BPMN generado — ${structure.steps.length} pasos, ${structure.roles.length} roles`);
        res.json({
            success: true,
            data:    mdMatch ? mdMatch[1].trim() : 'Análisis completado.',
            bpmn:    finalXml,
        });

    } catch (error) {
        console.error('Error crítico en el análisis:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 5. SERVIDOR
// ==========================================
const server = app.listen(4000, () =>
    console.log(`Servidor IA funcionando en puerto 4000 — modelo: ${CONFIG.model}`)
);
server.timeout          = CONFIG.timeout;
server.keepAliveTimeout = CONFIG.timeout;
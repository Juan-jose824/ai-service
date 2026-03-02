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

// ─────────────────────────────────────────────
// CONFIGURACIÓN CENTRAL — cambia aquí y afecta todo
// ─────────────────────────────────────────────
const CONFIG = {
    model:         'gemini-2.5-flash-lite', // tier gratuito: 1000 req/día, 15 RPM — cambia a 'gemini-2.5-flash' (250 RPD) si activas billing
    maxPdfChars:   12_000,              // más texto = más lento; 12k es suficiente para la mayoría
    maxTokens:     16_384,
    temperature:   0.2,                 // bajo = más determinista, menos alucinaciones
    timeout:       120_000,
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
        const tag = step.type || 'task';
        const outgoing = (step.next || [])
            .map(t => `      <outgoing>Flow_${step.id}_${t}</outgoing>`)
            .join('\n');
        const incoming = structure.steps
            .filter(s => (s.next || []).includes(step.id))
            .map(s => `      <incoming>Flow_${s.id}_${step.id}</incoming>`)
            .join('\n');
        // name escapado para XML válido
        const safeName = (step.name || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        return `    <${tag} id="${step.id}" name="${safeName}">\n${incoming}\n${outgoing}\n    </${tag}>`;
    }).join('\n');

    const sequences = structure.steps.flatMap(step =>
        (step.next || []).map(targetId => {
            const cond = step.conditions?.[targetId]
                ? ` name="${step.conditions[targetId].replace(/&/g,'&amp;')}"`
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
    const LANE_H      = 180;   // alto de cada carril
    const POOL_X      = 160;
    const POOL_Y      = 80;
    const LABEL_W     = 30;    // ancho del label del pool
    const COL_W       = 200;   // espacio horizontal entre nodos
    const START_X     = POOL_X + LABEL_W + 60;

    const NODE_SIZE = {
        startEvent:       { w: 36,  h: 36  },
        endEvent:         { w: 36,  h: 36  },
        exclusiveGateway: { w: 50,  h: 50  },
        userTask:         { w: 120, h: 80  },
        serviceTask:      { w: 120, h: 80  },
        task:             { w: 120, h: 80  },
    };

    // Y base de cada carril
    const roleY = {};
    structure.roles.forEach((role, i) => {
        roleY[role] = POOL_Y + i * LANE_H;
    });

    // Posición de cada nodo — distribuir por columnas dentro de su carril
    const colCount = {}; // cuántos nodos ya puestos por rol
    structure.roles.forEach(r => { colCount[r] = 0; });

    const positions = {};
    structure.steps.forEach(step => {
        const size  = NODE_SIZE[step.type] || NODE_SIZE.task;
        const col   = colCount[step.role] ?? 0;
        const laneY = roleY[step.role] ?? POOL_Y;
        positions[step.id] = {
            x: START_X + col * COL_W,
            y: laneY + (LANE_H - size.h) / 2,   // centrado vertical en el carril
            ...size,
        };
        colCount[step.role] = col + 1;
    });

    const totalCols  = Math.max(...Object.values(colCount));
    const poolW      = totalCols * COL_W + 160;
    const poolH      = structure.roles.length * LANE_H;

    // ── Pool
    let shapes = `      <bpmndi:BPMNShape id="Participant_1_di" bpmnElement="Participant_1" isHorizontal="true">
        <dc:Bounds x="${POOL_X}" y="${POOL_Y}" width="${poolW}" height="${poolH}"/>
      </bpmndi:BPMNShape>\n`;

    // ── Lanes
    structure.roles.forEach((role, i) => {
        shapes += `      <bpmndi:BPMNShape id="Lane_${i}_di" bpmnElement="Lane_${i}" isHorizontal="true">
        <dc:Bounds x="${POOL_X + LABEL_W}" y="${roleY[role]}" width="${poolW - LABEL_W}" height="${LANE_H}"/>
      </bpmndi:BPMNShape>\n`;
    });

    // ── Nodos
    structure.steps.forEach(step => {
        const p = positions[step.id];
        if (!p) return;
        shapes += `      <bpmndi:BPMNShape id="Shape_${step.id}" bpmnElement="${step.id}">
        <dc:Bounds x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}"/>
      </bpmndi:BPMNShape>\n`;
    });

    // ── Edges
    let edges = '';
    structure.steps.forEach(step => {
        const src = positions[step.id];
        if (!src) return;
        (step.next || []).forEach(targetId => {
            const tgt = positions[targetId];
            if (!tgt) return;
            // Punto de salida: borde derecho del origen
            // Punto de entrada: borde izquierdo del destino
            const x1 = src.x + src.w;
            const y1 = src.y + src.h / 2;
            const x2 = tgt.x;
            const y2 = tgt.y + tgt.h / 2;
            edges += `      <bpmndi:BPMNEdge id="Edge_${step.id}_${targetId}" bpmnElement="Flow_${step.id}_${targetId}">
        <di:waypoint x="${x1}" y="${y1}"/>
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
// 3. PROMPT — pide JSON estructurado, no XML
// ==========================================
function buildPrompt(text) {
    return `Eres un analista de procesos BPMN. Analiza el manual y devuelve el proceso en JSON.

REGLAS:
- Identifica TODOS los roles que interactúan (Ciudadano, Sistema, Brigadista, Coordinador, etc.)
- Crea un paso por cada acción concreta del manual. No resumas.
- Usa "exclusiveGateway" para decisiones (Sí/No, válido/inválido, etc.)
- Usa "startEvent" al inicio y "endEvent" al final de cada rol principal.
- El campo "next" contiene los IDs de los pasos siguientes (puede ser más de uno en gateways).
- El campo "conditions" es opcional: para gateways, indica la etiqueta de cada salida: {"IdDestino": "Sí"}.
- Los IDs deben ser únicos y sin espacios (ej: Task_Login, GW_CURPValida, End_Ciudadano).

FORMATO DE RESPUESTA — responde SOLO con esto, sin texto extra:

[MD_START]
Resumen breve: roles encontrados y cantidad de pasos.
[MD_END]
[JSON_START]
{
  "roles": ["Rol A", "Rol B"],
  "steps": [
    { "id": "Start_1",    "name": "Inicio",         "type": "startEvent",       "role": "Rol A", "next": ["Task_1"] },
    { "id": "Task_1",     "name": "Acción concreta", "type": "userTask",         "role": "Rol A", "next": ["GW_1"] },
    { "id": "GW_1",       "name": "¿Es válido?",     "type": "exclusiveGateway", "role": "Rol A", "next": ["Task_2","Task_1"], "conditions": {"Task_2":"Sí","Task_1":"No"} },
    { "id": "Task_2",     "name": "Otra acción",     "type": "serviceTask",      "role": "Rol B", "next": ["End_1"] },
    { "id": "End_1",      "name": "Fin",             "type": "endEvent",         "role": "Rol B", "next": [] }
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

        // Extraer texto del PDF
        const pdfData = await pdf(req.file.buffer);
        const rawText = pdfData.text.replace(/\s+/g, ' ').trim();

        // Tomar inicio + final del manual para no perder ni roles ni pasos finales
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

        // Extraer MD y JSON
        const mdMatch   = responseText.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);
        const jsonMatch = responseText.match(/\[JSON_START\]([\s\S]*?)\[JSON_END\]/);

        if (!jsonMatch) {
            console.error('Respuesta de Gemini sin bloque JSON:', responseText.substring(0, 500));
            throw new Error('Gemini no devolvió el bloque [JSON_START]...[JSON_END] esperado.');
        }

        let structure;
        try {
            // Limpiar posibles bloques markdown alrededor del JSON
            const rawJson = jsonMatch[1].replace(/```json|```/g, '').trim();
            structure = JSON.parse(rawJson);
        } catch (e) {
            throw new Error(`JSON inválido en la respuesta de Gemini: ${e.message}`);
        }

        if (!structure.roles?.length || !structure.steps?.length) {
            throw new Error('La estructura devuelta por Gemini no contiene roles o pasos.');
        }

        const processId = `Process_${Date.now()}`;
        const logicXml  = generateLogic(structure, processId);
        const visualXml = generateDI(structure, processId);

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
${visualXml}
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
server.timeout         = CONFIG.timeout;
server.keepAliveTimeout = CONFIG.timeout;
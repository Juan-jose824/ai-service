require('dotenv').config();
const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
<<<<<<< HEAD
app.use(express.json({ limit: '150mb' })); // Aumentado para XMLs grandes
=======
app.use(express.json({ limit: '150mb' }));
>>>>>>> cc1e00ccbf8d8ae723656972383c34cf04fb247a

// Configuración del Multer para manejar archivos en memoria
const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

<<<<<<< HEAD
// Función para limpiar y formatear el XML generado por Gemini
function cleanBPMN(xml) {
    if (!xml) return "";
    let cleaned = xml
        .replace(/```xml/g, '').replace(/```/g, '').trim()
        .replace(/<bpmn:/g, '<').replace(/<\/bpmn:/g, '</')
        .replace(/bpmndi:bpmndiagram/gi, 'bpmndi:BPMNDiagram')
        .replace(/bpmndi:bpmnplane/gi, 'bpmndi:BPMNPlane')
        .replace(/bpmndi:bpmnshape/gi, 'bpmndi:BPMNShape')
        .replace(/bpmndi:bpmnedge/gi, 'bpmndi:BPMNEdge')
        .replace(/bpmndi:bpmnlabel/gi, 'bpmndi:BPMNLabel');

    const firstTag = cleaned.indexOf('<definitions');
    if (firstTag !== -1) {
        cleaned = cleaned.substring(firstTag);
        const lastTag = cleaned.lastIndexOf('</definitions>');
        if (lastTag !== -1) cleaned = cleaned.substring(0, lastTag + 14);
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n` + cleaned;
}

app.post('/analyze', upload.single('file'), async (req, res) => {
    // 10 minutos de espera para la generación masiva de XML
    req.setTimeout(600000);

    try {
        console.log("--- GENERANDO BPMN COMPLEJO (MODELO 2.5) ---");
        if (!req.file) return res.status(400).json({ error: 'Archivo no recibido' });

        const data = await pdf(req.file.buffer);
        // Capturamos una muestra más grande para no perder los roles del manual
        const textSample = data.text.replace(/\s+/g, ' ').substring(0, 20000);

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Prompt para generar un XML basado en el manual
        const prompt = `Eres un experto en Bizagi Modeler. Analiza el manual y genera un XML BPMN 2.0 idéntico estructuralmente al estándar de Bizagi.
        
        REGLAS PARA EL XML:
        1. COLABORACIÓN: Define <collaboration> con <participant> y múltiples <lane> dentro de un <laneSet> para cada rol (Ej: Coordinador, Brigadista).
        2. DETALLE: No resumas. Crea una <task> para cada paso del manual (Login, Registro, Búsqueda, Validación).
        3. DIAGRAMADO (DI): Es obligatorio generar <bpmndi:BPMNDiagram>. 
           - Cada tarea DEBE tener un <bpmndi:BPMNShape> con <dc:Bounds x="..." y="..." width="100" height="80" />.
           - Coloca los elementos de un mismo rol en la misma franja de altura (Y).
           - Avanza horizontalmente (X) en pasos de 200 para evitar que se encimen.
        4. ETIQUETAS: Resumen en [MD_START] [MD_END] y XML en [XML_START] [XML_END].
        5. NO prefijos "bpmn:".

        MANUAL: ${textSample}`;

        const result = await model.generateContent(prompt);
        let responseText = result.response.text();


        //Extrae el XML y el resumen MD del texto de respuesta
        const xmlMatch = responseText.match(/\[XML_START\]([\s\S]*?)\[XML_END\]/);
        const mdMatch = responseText.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);

        // Limpia el XML para asegurar que sea válido y compatible con Bizagi
        const finalXml = cleanBPMN(xmlMatch ? xmlMatch[1] : "");
        const finalMd = mdMatch ? mdMatch[1].trim() : "Proceso analizado con éxito.";

        // Validación básica para el XML generado
        console.log("--- XML GENERADO EXITOSAMENTE ---");
        res.json({ success: true, data: finalMd, bpmn: finalXml });

    } catch (error) {
        console.error("Error crítico:", error.message);
        res.status(500).json({ error: "Error en el procesamiento de Gemini 2.5." });
    }
});

const server = app.listen(4000, () => console.log("Servidor IA con Gemini 2.5 y Timeout 10min"));
server.timeout = 600000;
=======
// ==========================================
// 1. GENERADOR DE LÓGICA BPMN (XML Estructural)
// ==========================================
function generateLogic(structure, processId) {
    let lanes = structure.roles.map((role, idx) => {
        const stepsInLane = structure.steps
            .filter(s => s.role === role)
            .map(s => `<flowNodeRef>${s.id}</flowNodeRef>`)
            .join('\n      ');
        return `<lane id="Lane_${idx}" name="${role}">\n      ${stepsInLane}\n    </lane>`;
    }).join('\n  ');

    let tasks = structure.steps.map(step => {
        let tag = step.type || "task";
        const outgoing = (step.next || []).map((targetId, i) => 
            `<outgoing>Flow_${step.id}_${targetId}</outgoing>`).join('\n    ');
        return `    <${tag} id="${step.id}" name="${step.name}">\n    ${outgoing}\n    </${tag}>`;
    }).join('\n');

    let sequences = "";
    structure.steps.forEach(step => {
        (step.next || []).forEach(targetId => {
            sequences += `    <sequenceFlow id="Flow_${step.id}_${targetId}" sourceRef="${step.id}" targetRef="${targetId}" />\n`;
        });
    });

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
// 2. TU FUNCIÓN GENERATEDI (XML Visual/Coordenadas)
// ==========================================
function generateDI(structure, processId) {
    const laneHeight = 250;
    const laneStartY = 100;
    const columnWidth = 250;

    const nodeSize = {
        startEvent: { w: 36, h: 36 },
        endEvent: { w: 36, h: 36 },
        exclusiveGateway: { w: 50, h: 50 },
        userTask: { w: 120, h: 80 },
        serviceTask: { w: 120, h: 80 },
        task: { w: 120, h: 80 }
    };

    const roleY = {};
    structure.roles.forEach((role, index) => {
        roleY[role] = laneStartY + (index * laneHeight);
    });

    const levels = {};
    const visiting = new Set();

    function assignLevel(stepId, level = 0) {
        if (levels[stepId] !== undefined && levels[stepId] >= level) return;
        if (visiting.has(stepId)) return;
        visiting.add(stepId);
        levels[stepId] = level;
        const step = structure.steps.find(s => s.id === stepId);
        if (step && step.next) {
            step.next.forEach(nextId => assignLevel(nextId, level + 1));
        }
        visiting.delete(stepId);
    }

    const startNode = structure.steps.find(s => s.type.includes("start")) || structure.steps[0];
    if (startNode) assignLevel(startNode.id);

    const positions = {};
    structure.steps.forEach(step => {
        const level = levels[step.id] || 0;
        const x = 200 + (level * columnWidth);
        const y = (roleY[step.role] || laneStartY) + (laneHeight / 2) - 40;
        positions[step.id] = { x, y };
    });

    let shapes = "";
    let edges = "";

    structure.steps.forEach(step => {
        const { x, y } = positions[step.id];
        const size = nodeSize[step.type] || nodeSize.task;
        shapes += `
      <bpmndi:BPMNShape id="Shape_${step.id}" bpmnElement="${step.id}">
        <dc:Bounds x="${x}" y="${y}" width="${size.w}" height="${size.h}"/>
      </bpmndi:BPMNShape>`;

        (step.next || []).forEach(targetId => {
            const sourcePos = positions[step.id];
            const targetPos = positions[targetId];
            if (!targetPos) return;
            const sSize = nodeSize[step.type] || nodeSize.task;
            const tSize = nodeSize[structure.steps.find(s=>s.id===targetId)?.type] || nodeSize.task;

            edges += `
      <bpmndi:BPMNEdge id="Edge_${step.id}_${targetId}" bpmnElement="Flow_${step.id}_${targetId}">
        <di:waypoint x="${sourcePos.x + sSize.w}" y="${sourcePos.y + sSize.h/2}"/>
        <di:waypoint x="${targetPos.x}" y="${targetPos.y + tSize.h/2}"/>
      </bpmndi:BPMNEdge>`;
        });
    });

    return `
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane bpmnElement="${processId}">
      ${shapes}
      ${edges}
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>`;
}

// ==========================================
// 3. RUTA PRINCIPAL
// ==========================================
app.post('/analyze', upload.single('file'), async (req, res) => {
    req.setTimeout(600000);
    try {
        if (!req.file) return res.status(400).json({ error: 'Archivo no recibido' });

        const data = await pdf(req.file.buffer);
        const textSample = data.text.replace(/\s+/g, ' ').substring(0, 15000);

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Analiza el manual y extrae el proceso.
        Responde estrictamente en este formato:
        [MD_START] Resumen del manual [MD_END]
        [JSON_START]
        {
          "roles": ["Nombre Rol 1", "Nombre Rol 2"],
          "steps": [
            {
              "id": "Activity_1",
              "name": "Descripción corta",
              "type": "userTask", 
              "role": "Nombre Rol 1",
              "next": ["Activity_2"]
            }
          ]
        }
        [JSON_END]
        
        REGLAS DE TIPO: 
        - startEvent (inicio), endEvent (fin), userTask (manual), serviceTask (sistema), exclusiveGateway (decisión).
        
        MANUAL: ${textSample}`;

        const result = await model.generateContent(prompt);
        const responseText = result.response.text();

        const mdMatch = responseText.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);
        const jsonMatch = responseText.match(/\[JSON_START\]([\s\S]*?)\[JSON_END\]/);

        if (!jsonMatch) throw new Error("Gemini no generó el JSON correctamente.");

        const structure = JSON.parse(jsonMatch[1].trim());
        const processId = "Process_" + Date.now();

        const logic = generateLogic(structure, processId);
        const visual = generateDI(structure, processId);

        const finalXml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" 
             xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" 
             xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" 
             xmlns:di="http://www.omg.org/spec/DD/20100524/DI" 
             targetNamespace="http://bpmn.io/schema/bpmn">
  ${logic}
  ${visual}
</definitions>`;

        res.json({ success: true, data: mdMatch ? mdMatch[1] : "Analizado", bpmn: finalXml });

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(4000, () => console.log("Servidor IA funcionando en puerto 4000"));
>>>>>>> cc1e00ccbf8d8ae723656972383c34cf04fb247a

const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
app.use(express.json({ limit: '150mb' })); // Aumentado para XMLs grandes

const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

        const xmlMatch = responseText.match(/\[XML_START\]([\s\S]*?)\[XML_END\]/);
        const mdMatch = responseText.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);

        const finalXml = cleanBPMN(xmlMatch ? xmlMatch[1] : "");
        const finalMd = mdMatch ? mdMatch[1].trim() : "Proceso analizado con éxito.";

        console.log("--- XML GENERADO EXITOSAMENTE ---");
        res.json({ success: true, data: finalMd, bpmn: finalXml });

    } catch (error) {
        console.error("Error crítico:", error.message);
        res.status(500).json({ error: "Error en el procesamiento de Gemini 2.5." });
    }
});

const server = app.listen(4000, () => console.log("Servidor IA con Gemini 2.5 y Timeout 10min"));
server.timeout = 600000;
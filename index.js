const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(cors());
app.use(express.json({ limit: '100mb' }));

const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.post('/analyze', upload.single('file'), async (req, res) => {
    try {
        console.log("--- PROCESANDO DOCUMENTO ---");
        if (!req.file) return res.status(400).json({ error: 'Archivo no recibido' });

        const data = await pdf(req.file.buffer);
        const fullText = data.text.replace(/\s+/g, ' ');
        
        // Muestreo inteligente para manuales de 100+ páginas
        const partSize = 8000;
        const textSample = fullText.substring(0, partSize) + 
                           "\n[...SECCIÓN INTERMEDIA...]\n" + 
                           fullText.substring(fullText.length - partSize);

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `Analiza este manual y genera un diagrama BPMN 2.0.
        PASO 1: Resumen en Markdown entre [MD_START] y [MD_END].
        PASO 2: Código XML BPMN 2.0 puro entre [XML_START] y [XML_END].
        IMPORTANTE: No incluyas explicaciones fuera de las etiquetas. El XML debe iniciar con <bpmn:definitions.
        TEXTO: ${textSample}`;

        console.log("Llamando a Gemini 2.5...");
        const result = await model.generateContent(prompt);
        let responseText = result.response.text();

        // Extracción y Limpieza del XML
        const xmlMatch = responseText.match(/\[XML_START\]([\s\S]*?)\[XML_END\]/);
        let finalXml = xmlMatch ? xmlMatch[1].trim() : "";
        
        // Limpieza profunda de etiquetas Markdown y caracteres invisibles
        finalXml = finalXml
            .replace(/```xml/g, '')
            .replace(/```/g, '')
            .replace(/^[^<]+/, '') // Elimina cualquier texto antes del primer '<'
            .trim();

        const mdMatch = responseText.match(/\[MD_START\]([\s\S]*?)\[MD_END\]/);
        let finalMd = mdMatch ? mdMatch[1].trim() : "Resumen no disponible.";

        console.log("--- FINALIZADO CON ÉXITO ---");
        res.json({ success: true, data: finalMd, bpmn: finalXml });

    } catch (error) {
        console.error("Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

const server = app.listen(4000, () => console.log("IA Puerto 4000"));
server.timeout = 600000; // 10 minutos
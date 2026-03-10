const axios = require("axios");

const OPENCLAW_URL = process.env.OPENCLAW_URL || "http://openclaw:3333";

// ==============================
// ANALISIS GENERAL DEL MANUAL
// ==============================

async function analyzeManual(text) {

  try {

    const res = await axios.post(`${OPENCLAW_URL}/api/agent/run`, {
      input: `
Analiza el siguiente manual técnico.

Extrae:
- módulos del sistema
- roles de usuario
- sistemas involucrados
- APIs
- flujo general

Devuelve JSON estructurado.

MANUAL:
${text}
`
    });

    return res.data;

  } catch (err) {

    console.error("OpenClaw analyze error:", err.message);
    return null;

  }

}

// ==============================
// DETECCION DE PROCESOS
// ==============================

async function detectProcesses(text) {

  try {

    const res = await axios.post(`${OPENCLAW_URL}/api/agent/run`, {
      input: `
Analiza este manual de sistema.

Detecta procesos de negocio independientes.

Devuelve JSON con formato:

{
 "processes":[
   {
     "name":"nombre del proceso",
     "description":"breve descripción",
     "actors":["actor1","actor2"]
   }
 ]
}

MANUAL:
${text}
`
    });

    return res.data;

  } catch (err) {

    console.error("OpenClaw process detection error:", err.message);

    return {
      processes: [
        {
          name: "Proceso principal",
          description: "Proceso detectado automáticamente",
          actors: ["usuario", "sistema"]
        }
      ]
    };

  }

}

module.exports = {
  analyzeManual,
  detectProcesses
};
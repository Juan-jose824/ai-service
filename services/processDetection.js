const { detectProcesses } = require("../openclaw/client");

async function detectBusinessProcesses(manualText) {

  console.log("Detectando procesos con OpenClaw...");

  const result = await detectProcesses(manualText);

  if (!result || !result.processes) {

    return [
      {
        name: "Proceso principal",
        description: "Proceso detectado automáticamente",
        actors: ["usuario", "sistema"]
      }
    ];

  }

  return result.processes;

}

module.exports = { detectBusinessProcesses };
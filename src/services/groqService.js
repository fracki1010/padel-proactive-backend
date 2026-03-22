// src/services/groqService.js
require("dotenv").config();
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
// 1. IMPORTAMOS EL NUEVO SERVICIO
const courtService = require("./courtService");

// Verificamos API Key
if (!process.env.GROQ_API_KEY) {
  console.error("ERROR: No se encontró la GROQ_API_KEY en el archivo .env");
  process.exit(1);
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Función principal
const getChatResponse = async (messagesHistory, userName = null) => {
  try {
    // 1. CONFIGURACIÓN DE FECHA "BLINDADA" (TimeZone Fix)
    // Obtenemos la fecha actual del servidor
    const serverDate = new Date();

    // Forzamos la conversión a hora Argentina para obtener el objeto Date correcto visualmente
    const argentinaDate = new Date(
      serverDate.toLocaleString("en-US", {
        timeZone: "America/Argentina/Buenos_Aires",
      }),
    );

    // A. Fecha Humana (Para que la IA entienda "Jueves 5...")
    const options = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    const fechaHumana = argentinaDate.toLocaleString("es-AR", options);

    // B. Fecha ISO "HOY" (YYYY-MM-DD) corregida a Argentina
    // No usamos toISOString() directo porque volvería a convertir a UTC
    const year = argentinaDate.getFullYear();
    const month = String(argentinaDate.getMonth() + 1).padStart(2, "0");
    const day = String(argentinaDate.getDate()).padStart(2, "0");
    const fechaISO = `${year}-${month}-${day}`;

    // A. Cargar contexto del negocio (business_info.txt)
    const infoPath = path.join(process.cwd(), "business_info.txt");
    let contextoNegocio = "";
    try {
      contextoNegocio = fs.readFileSync(infoPath, "utf8");
    } catch (e) {
      contextoNegocio = "Eres un asistente de pádel.";
    }

    // B. OBTENER INSTRUCCIONES DINÁMICAS DE LAS CANCHAS
    // Esto determina si la IA debe preguntar la cancha o usar "INDIFERENTE"
    const { instructions: courtInstructions } =
      await courtService.getCourtSummary();

    // D. Configuración de Usuario (Memoria)
    let userInstruction = "";
    if (userName) {
      userInstruction = `
        [CLIENTE IDENTIFICADO]
        - Hablas con "${userName}". NO preguntes su nombre.
        - Usa "${userName}" en el campo "clientName" del JSON.
        `;
    } else {
      userInstruction = `
        [CLIENTE DESCONOCIDO]
        - No conoces el nombre del usuario.
        - Si quiere reservar, DEBES preguntar su nombre obligatoriamente.
        - NOMBRE Y APELLIDO DEL CLIENTE (darle este ejemplo siempre ej: "Juan Pérez").
        `;
    }

    // E. EL PROMPT MAESTRO
    const systemPrompt = `
    ${contextoNegocio}
    
    [INSTRUCCIONES DE CANCHAS - CRITICO]
    ${courtInstructions}

    ${userInstruction}

    [DATOS DEL SISTEMA]
    - FECHA Y HORA ACTUAL: ${fechaHumana}.
    - FECHA ISO HOY: ${fechaISO}.
    - Si el usuario dice "mañana", debes calcular la fecha basándote en "${fechaISO}".
    
    [TU COMPORTAMIENTO]
    - Eres amable, conciso y vas al grano.
    - Si el usuario quiere reservar, genera el JSON 'CREATE_BOOKING'.
    - Si pregunta disponibilidad, genera 'CHECK_AVAILABILITY'.
    - Si el usuario quiere cancelar un turno, genera 'CANCEL_BOOKING'.
    - Para cancelar, DEBES confirmar la fecha y hora con el usuario antes de proceder si los datos no son claros.

    [SALIDA JSON REQUERIDA]
    
    CASO 1: RESERVAR
    {
      "action": "CREATE_BOOKING",
      "courtName": "Nombre de la cancha" O "INDIFERENTE", 
      "date": "YYYY-MM-DD",
      "time": "HH:mm",
      "clientName": "Nombre"
    }

    CASO 2: CONSULTAR DISPONIBILIDAD
    {
      "action": "CHECK_AVAILABILITY",
      "date": "YYYY-MM-DD"
    }

    CASO 3: CANCELAR TURNO
    {
      "action": "CANCEL_BOOKING",
      "date": "YYYY-MM-DD",
      "time": "HH:mm"
    }

    CASO 4: CHARLA NORMAL
    {
       "message": "Respuesta normal..."
    }
    `;

    // Construimos la conversación
    const conversation = [
      { role: "system", content: systemPrompt },
      ...messagesHistory,
    ];

    // Llamada a la IA
    const chatCompletion = await groq.chat.completions.create({
      messages: conversation,
      model: "llama-3.3-70b-versatile",
      temperature: 0.1, // Baja temperatura para obedecer las reglas estrictas
      max_tokens: 300,
      response_format: { type: "json_object" },
    });

    return chatCompletion.choices[0]?.message?.content || "";
  } catch (error) {
    console.error("Error Groq:", error);
    return JSON.stringify({
      message: "Estoy teniendo unos segundos de demora, ¿me repetís?",
    });
  }
};

module.exports = { getChatResponse };

// src/services/groqService.js
require("dotenv").config();
const Groq = require("groq-sdk");
const fs = require("fs");
const path = require("path");
const Company = require("../models/company.model");
// 1. IMPORTAMOS EL NUEVO SERVICIO
const courtService = require("./courtService");

// Verificamos API Key
if (!process.env.GROQ_API_KEY) {
  console.error("ERROR: No se encontró la GROQ_API_KEY en el archivo .env");
  process.exit(1);
}

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const getClubNameByCompanyId = async (companyId = null) => {
  try {
    if (!companyId) return null;
    const company = await Company.findById(companyId).select("name").lean();
    return company?.name?.trim() || null;
  } catch (error) {
    console.error("Error obteniendo nombre del club:", error);
    return null;
  }
};

// Función principal
const getChatResponse = async (
  messagesHistory,
  userName = null,
  options = {},
) => {
  try {
    const companyId = options.companyId || null;
    const clubNameFromDb = await getClubNameByCompanyId(companyId);
    const defaultClubName = process.env.DEFAULT_CLUB_NAME || "Club de Pádel";
    const clubName = clubNameFromDb || defaultClubName;
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
    const dateFormatOptions = {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    };
    const fechaHumana = argentinaDate.toLocaleString("es-AR", dateFormatOptions);

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

    // Reemplazamos cualquier nombre legacy para evitar contradicciones con el club real.
    contextoNegocio = contextoNegocio
      .replace(/Tie Break Padel/gi, clubName)
      .replace(/Tie Break/gi, clubName);

    // B. OBTENER INSTRUCCIONES DINÁMICAS DE LAS CANCHAS
    // Esto determina si la IA debe preguntar la cancha o usar "INDIFERENTE"
    const { instructions: courtInstructions } =
      await courtService.getCourtSummary(companyId);

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

    [IDENTIDAD DEL CLUB - CRITICO]
    - Nombre oficial del club para ESTA conversación: "${clubName}".
    - Si nombras al club, usa siempre "${clubName}".
    - Ignora cualquier nombre anterior o de ejemplo.
    
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
    - Si pide "turno fijo" (o similar), genera 'FIXED_TURN_REQUEST'. No prometas confirmación automática.
    - Para cancelar, DEBES confirmar la fecha y hora con el usuario antes de proceder si los datos no son claros.
    
    [AMBIGUEDADES - REGLAS OBLIGATORIAS]
    - Frases como "¿tenés algo para hoy a las 17?" o "algo para las 17" significan CONSULTA DE DISPONIBILIDAD, no reserva confirmada.
    - Si dicen solo una hora (ej: "a las 17"), asume fecha = hoy (${fechaISO}) y usa "time": "17:00" en CHECK_AVAILABILITY.
    - Si dicen "hoy 17", también es CHECK_AVAILABILITY con date=${fechaISO} y time="17:00".
    - En CHECK_AVAILABILITY, incluye "time" cuando el usuario mencione una hora puntual.
    - Si faltan datos para interpretar fecha/hora, pregunta aclaración en "message".

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
      "date": "YYYY-MM-DD",
      "time": "HH:mm" // opcional, solo si pidió una hora puntual
    }

    CASO 3: CANCELAR TURNO
    {
      "action": "CANCEL_BOOKING",
      "date": "YYYY-MM-DD",
      "time": "HH:mm"
    }

    CASO 4: PEDIDO DE TURNO FIJO
    {
      "action": "FIXED_TURN_REQUEST",
      "date": "YYYY-MM-DD", // opcional
      "time": "HH:mm", // opcional
      "message": "Resumen corto del pedido"
    }

    CASO 5: CHARLA NORMAL
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

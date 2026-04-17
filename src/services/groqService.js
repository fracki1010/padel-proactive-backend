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
const PRIMARY_MODEL = process.env.GROQ_MODEL_PRIMARY || "llama-3.3-70b-versatile";
const FALLBACK_MODEL = process.env.GROQ_MODEL_FALLBACK || "llama-3.1-8b-instant";
const PRIMARY_MAX_TOKENS = Number(process.env.GROQ_MAX_TOKENS || 220);
const FALLBACK_MAX_TOKENS = Number(process.env.GROQ_FALLBACK_MAX_TOKENS || 140);
const MAX_HISTORY_MESSAGES = Number(process.env.GROQ_MAX_HISTORY || 8);
const MAX_BUSINESS_CONTEXT_CHARS = Number(
  process.env.GROQ_MAX_BUSINESS_CONTEXT_CHARS || 2200,
);

const truncateText = (text = "", maxChars = 2200) => {
  const clean = String(text || "");
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars)}\n\n[Contexto resumido por límite de tokens]`;
};

const parseRetryAfterSeconds = (retryAfterHeader) => {
  const asNumber = Number(retryAfterHeader);
  if (!Number.isNaN(asNumber) && asNumber > 0) return asNumber;
  return null;
};

const formatRetryWindow = (seconds) => {
  if (!seconds || seconds <= 0) return "unos minutos";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins <= 0) return `${secs}s`;
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
};

const isDailyTokenRateLimit = (error) => {
  const status = error?.status;
  const code = error?.error?.error?.code || error?.error?.code;
  const message = String(error?.error?.error?.message || error?.message || "").toLowerCase();
  return (
    status === 429 &&
    (code === "rate_limit_exceeded" || message.includes("rate limit")) &&
    (message.includes("tokens per day") || message.includes("tpd") || message.includes("limit"))
  );
};

const requestChatCompletion = async ({ conversation, model, maxTokens }) => {
  const completion = await groq.chat.completions.create({
    messages: conversation,
    model,
    temperature: 0.1,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  });

  return completion.choices[0]?.message?.content || "";
};

const getClubInfoByCompanyId = async (companyId = null) => {
  try {
    if (!companyId) return null;
    const company = await Company.findById(companyId).select("name address").lean();
    if (!company) return null;
    return {
      name: company?.name?.trim() || null,
      address: company?.address?.trim() || "",
    };
  } catch (error) {
    console.error("Error obteniendo datos del club:", error);
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
    const strictQuestionFlowEnabled = Boolean(options.strictQuestionFlowEnabled);
    const clubInfoFromDb = await getClubInfoByCompanyId(companyId);
    const defaultClubName = process.env.DEFAULT_CLUB_NAME || "Club de Pádel";
    const clubName = clubInfoFromDb?.name || defaultClubName;
    const clubAddress = clubInfoFromDb?.address || "";
    const hasClubAddress = Boolean(clubAddress);
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
    contextoNegocio = truncateText(contextoNegocio, MAX_BUSINESS_CONTEXT_CHARS);

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
    - Dirección registrada del club: ${hasClubAddress ? `"${clubAddress}".` : '"No registrada".'}
    - Si te preguntan por ubicación/dirección/cómo llegar y hay dirección registrada, respóndela textual.
    - Si no hay dirección registrada, responde que no está configurada y sugiere contactar a administración.
    
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
    - Si pregunta por sus reservas/turnos vigentes, genera 'LIST_ACTIVE_BOOKINGS'.
    - Si el usuario quiere cancelar un turno, genera 'CANCEL_BOOKING'.
    - Si pide "turno fijo" (o similar), genera 'FIXED_TURN_REQUEST'. No prometas confirmación automática.
    - Para cancelar, DEBES confirmar la fecha y hora con el usuario antes de proceder si los datos no son claros.
    - IMPORTANTE: nunca asumas confirmación final por un "sí" ambiguo.
    - Si el usuario corrige horario/día/cancha, trátalo como edición del pedido, no como confirmación.
    - Si el pedido menciona más de un turno en el mismo mensaje, prioriza claridad y no lo reduzcas a un solo turno.
    - Nunca inventes precios, horarios o disponibilidad.
    - Nunca inventes la dirección del club.
    - Si no conoces un dato, pide aclaración o responde que no está disponible ese dato.
    ${strictQuestionFlowEnabled ? `
    [FLUJO ESTRICTO - OBLIGATORIO]
    - Haz una sola pregunta por mensaje.
    - Si faltan varios datos, pide solo uno por turno.
    - Orden obligatorio cuando faltan datos para reservar: 1) nombre completo, 2) fecha, 3) hora.
    - Nunca pidas dos datos a la vez.` : ""}
    
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

    CASO 4: LISTAR RESERVAS VIGENTES DEL CLIENTE
    {
      "action": "LIST_ACTIVE_BOOKINGS"
    }

    CASO 5: PEDIDO DE TURNO FIJO
    {
      "action": "FIXED_TURN_REQUEST",
      "date": "YYYY-MM-DD", // opcional
      "time": "HH:mm", // opcional
      "message": "Resumen corto del pedido"
    }

    CASO 6: CHARLA NORMAL
    {
       "message": "Respuesta normal..."
    }
    `;

    // Construimos la conversación
    const limitedHistory = Array.isArray(messagesHistory)
      ? messagesHistory.slice(-MAX_HISTORY_MESSAGES)
      : [];

    const conversation = [
      { role: "system", content: systemPrompt },
      ...limitedHistory,
    ];

    try {
      return await requestChatCompletion({
        conversation,
        model: PRIMARY_MODEL,
        maxTokens: PRIMARY_MAX_TOKENS,
      });
    } catch (primaryError) {
      if (isDailyTokenRateLimit(primaryError)) {
        try {
          const reducedConversation = [
            { role: "system", content: systemPrompt },
            ...limitedHistory.slice(-4),
          ];
          return await requestChatCompletion({
            conversation: reducedConversation,
            model: FALLBACK_MODEL,
            maxTokens: FALLBACK_MAX_TOKENS,
          });
        } catch (fallbackError) {
          const retryAfterHeader =
            fallbackError?.headers?.["retry-after"] ||
            primaryError?.headers?.["retry-after"];
          const retryInSeconds = parseRetryAfterSeconds(retryAfterHeader);
          const retryWindow = formatRetryWindow(retryInSeconds);

          console.error("Groq rate limit (fallback también falló):", {
            primaryStatus: primaryError?.status,
            fallbackStatus: fallbackError?.status,
            retryAfter: retryAfterHeader || null,
          });

          return JSON.stringify({
            action: "SERVICE_DEGRADED",
            retryAfterSeconds: retryInSeconds || null,
            retryAfterText: retryWindow,
            message:
              `⚠️ Estamos al límite diario de consultas IA. ` +
              `Volvé a intentar en ${retryWindow}. Mientras tanto, podés escribir fecha y hora y te ayudo desde el modo básico.`,
          });
        }
      }

      throw primaryError;
    }
  } catch (error) {
    console.error("Error Groq:", error);
    return JSON.stringify({
      message:
        "Estoy con una demora técnica breve. No hace falta repetir: ya recibí tu mensaje y sigo en cuanto se libere.",
    });
  }
};

module.exports = { getChatResponse };

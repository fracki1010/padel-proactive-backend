const groqService = require("../services/groqService");
const sessionService = require("../services/sessionService");
const bookingService = require("../services/bookingService");
const userService = require("../services/userService");
const { sendAdminNotification } = require("../services/notificationService");
const { getFormattedDate } = require("../utils/getFormattedDate");
const { getNumberByUser } = require("../utils/getNumberByUser");

// --- FUNCIÓN HELPER PARA EXTRAER JSON ---
// Busca cualquier cosa que parezca un objeto JSON {...} dentro del texto
const extractJSON = (text) => {
  try {
    // 1. Intento directo
    return JSON.parse(text);
  } catch (e) {
    // 2. Buscar patrón { ... } ignorando lo que haya fuera
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        return null; // No es un JSON válido
      }
    }
    return null;
  }
};

const getTodayIsoArgentina = () => {
  const argentinaNow = new Date(
    new Date().toLocaleString("en-US", {
      timeZone: "America/Argentina/Buenos_Aires",
    }),
  );
  const year = argentinaNow.getFullYear();
  const month = String(argentinaNow.getMonth() + 1).padStart(2, "0");
  const day = String(argentinaNow.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeTimeString = (rawTime) => {
  if (!rawTime && rawTime !== 0) return null;
  const text = String(rawTime).trim();
  const fullMatch = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (fullMatch) {
    return `${fullMatch[1].padStart(2, "0")}:${fullMatch[2]}`;
  }

  const hourOnlyMatch = text.match(/^([01]?\d|2[0-3])$/);
  if (hourOnlyMatch) {
    return `${hourOnlyMatch[1].padStart(2, "0")}:00`;
  }

  return null;
};

const isValidIsoDate = (value) => {
  if (!value) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

const normalizeSpanishText = (text = "") =>
  String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const addDaysToIsoDate = (isoDate, days) => {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const extractDateFromMessage = (rawText) => {
  const text = normalizeSpanishText(rawText);
  const today = getTodayIsoArgentina();

  if (text.includes("pasado manana")) return addDaysToIsoDate(today, 2);
  if (text.includes("manana")) return addDaysToIsoDate(today, 1);
  if (text.includes("hoy")) return today;

  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch && isValidIsoDate(isoMatch[1])) return isoMatch[1];

  const dmyMatch = text.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (!dmyMatch) return null;

  const day = Number(dmyMatch[1]);
  const month = Number(dmyMatch[2]);
  const currentYear = Number(today.slice(0, 4));
  const rawYear = dmyMatch[3];
  let year = currentYear;
  if (rawYear) {
    year = Number(rawYear.length === 2 ? `20${rawYear}` : rawYear);
  }

  const candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isValidIsoDate(candidate) ? candidate : null;
};

const extractTimeFromMessage = (rawText) => {
  const text = normalizeSpanishText(rawText);

  const hourMinuteMatch = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (hourMinuteMatch) {
    return `${hourMinuteMatch[1].padStart(2, "0")}:${hourMinuteMatch[2]}`;
  }

  const hourHsMatch = text.match(/\b([01]?\d|2[0-3])\s*(?:hs|h)\b/);
  if (hourHsMatch) return `${hourHsMatch[1].padStart(2, "0")}:00`;

  const aLasMatch = text.match(/a\s*las\s*([01]?\d|2[0-3])\b/);
  if (aLasMatch) return `${aLasMatch[1].padStart(2, "0")}:00`;

  return null;
};

const inferFallbackAction = (rawText) => {
  const text = normalizeSpanishText(rawText);

  const isFixedTurn =
    /turno\s*fijo|fijo\s+semanal|semanal|todas\s+las\s+semanas/.test(text);
  if (isFixedTurn) {
    return {
      action: "FIXED_TURN_REQUEST",
      date: extractDateFromMessage(text),
      time: extractTimeFromMessage(text),
    };
  }

  const hasAvailabilityIntent =
    /tenes|tenes|hay|queda|quedan|disponible|libre|algo\s+para/.test(text);
  const date = extractDateFromMessage(text);
  const time = extractTimeFromMessage(text);

  if (hasAvailabilityIntent && (date || time)) {
    return {
      action: "CHECK_AVAILABILITY",
      date: date || getTodayIsoArgentina(),
      time,
    };
  }

  return null;
};

const normalizeNameText = (value = "") =>
  String(value)
    .trim()
    .replace(/\s+/g, " ");

const isLikelyFullName = (value = "") => {
  const clean = normalizeNameText(value);
  const parts = clean.split(" ").filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part) => /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]{2,}$/.test(part));
};

const isPlaceholderName = (value = "") => {
  const normalized = normalizeSpanishText(value)
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const placeholders = new Set([
    "juan perez",
    "cliente",
    "cliente desconocido",
    "nombre apellido",
    "socio",
    "invitado",
  ]);
  return placeholders.has(normalized);
};

const extractFullNameFromMessage = (rawMessage, aiCandidate = "") => {
  const raw = String(rawMessage || "").trim();

  const explicitPatterns = [
    /(?:mi\s+nombre\s+es|soy)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]{4,})/i,
    /^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ' -]{4,})$/,
  ];

  for (const pattern of explicitPatterns) {
    const match = raw.match(pattern);
    if (!match?.[1]) continue;
    const candidate = normalizeNameText(match[1]);
    if (isLikelyFullName(candidate) && !isPlaceholderName(candidate)) {
      return candidate;
    }
  }

  const candidateFromAi = normalizeNameText(aiCandidate);
  if (
    candidateFromAi &&
    isLikelyFullName(candidateFromAi) &&
    !isPlaceholderName(candidateFromAi)
  ) {
    const normalizedMessage = normalizeSpanishText(raw)
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const normalizedCandidate = normalizeSpanishText(candidateFromAi)
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (normalizedMessage.includes(normalizedCandidate)) {
      return candidateFromAi;
    }
  }

  return null;
};

const buildBookingReplyText = (requestedDate, requestedClientName, bookingResult) => {
  if (bookingResult.success) {
    return (
      `✅ *¡Reserva Confirmada!* 🎾\n\n` +
      `👤 *Jugador:* ${requestedClientName}\n` +
      `📌 *Cancha:* ${bookingResult.data.courtName}\n` +
      `📅 *Fecha:* ${getFormattedDate(requestedDate)}\n` +
      `⏰ *Hora:* ${bookingResult.data.startTime} - ${bookingResult.data.endTime}\n` +
      `💰 *Precio:* $${bookingResult.data.price}`
    );
  }

  if (bookingResult.error === "BUSY") return "🚫 Ese turno ya está ocupado. ¿Te busco otro?";
  if (bookingResult.error === "INVALID_TIME") return "⚠️ Ese horario no existe en la grilla.";
  if (bookingResult.error === "PAST_TIME") {
    return "⏰ Ese horario ya pasó o ya comenzó. Decime otro turno y te ayudo a reservarlo.";
  }
  if (bookingResult.error === "CANCHA_NOT_FOUND") {
    return "⚠️ No encontré esa cancha. Decime el nombre exacto o te asigno la primera disponible.";
  }
  if (bookingResult.error === "SUSPENDED") {
    return (
      `🚫 *Tu cuenta está suspendida.*\n\n` +
      `Has acumulado demasiadas cancelaciones y no podés reservar nuevos turnos por el momento.\n` +
      `Contactá a la administración del club para regularizar tu situación.`
    );
  }
  return "⚠️ Hubo un error técnico al reservar.";
};

const handleIncomingMessage = async (chatId, userMessage, options = {}) => {
  try {
    const companyId = options.companyId || null;
    const client = options.client || null;
    const sessionId = companyId ? `${companyId}:${chatId}` : chatId;
    const sessionMeta = sessionService.getMeta(sessionId);

    // 1. Identificar Usuario
    const registeredUser = await userService.getUserByWhatsappId(chatId, {
      companyId,
    });
    let knownName = registeredUser ? registeredUser.name : null;
    const number = await getNumberByUser(chatId, client);
    console.log(`👤 Mensaje de: ${knownName || chatId}`);
    console.log(`📞 Número de WhatsApp: ${number}`);

    // Si estábamos esperando nombre completo para una reserva pendiente, lo resolvemos antes de llamar a IA.
    if (!knownName && sessionMeta.awaitingFullNameForBooking) {
      const fullName = extractFullNameFromMessage(userMessage);
      if (!fullName) {
        const retryNamePrompt =
          "Antes de continuar con tu turno, pasame tu *nombre completo* para registrarte (ej: *Juan Pérez*). Es para dejar el turno a tu nombre.";
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", retryNamePrompt);
        return retryNamePrompt;
      }

      const savedUser = await userService.saveOrUpdateUser(chatId, fullName, {
        companyId,
        client,
      });
      knownName = savedUser?.name || fullName;

      const pendingBooking = sessionMeta.pendingBooking || null;
      if (pendingBooking?.dateStr && pendingBooking?.timeStr) {
        const bookingResult = await bookingService.createNewBooking({
          companyId,
          courtName: pendingBooking.courtName || "INDIFERENTE",
          dateStr: pendingBooking.dateStr,
          timeStr: pendingBooking.timeStr,
          clientName: knownName,
          clientPhone: number,
        });

        const replyText = buildBookingReplyText(
          pendingBooking.dateStr,
          knownName,
          bookingResult,
        );
        sessionService.updateMeta(sessionId, {
          awaitingFullNameForBooking: false,
          pendingBooking: null,
        });
        sessionService.addMessage(sessionId, "user", userMessage);
        sessionService.addMessage(sessionId, "assistant", replyText);
        return replyText;
      }

      const continueReply =
        `Perfecto, ${knownName}. Ya te registré en el sistema ✅\n` +
        "Ahora sí, decime fecha y hora del turno y te lo reservo.";
      sessionService.updateMeta(sessionId, {
        awaitingFullNameForBooking: false,
        pendingBooking: null,
      });
      sessionService.addMessage(sessionId, "user", userMessage);
      sessionService.addMessage(sessionId, "assistant", continueReply);
      return continueReply;
    }

    // 2. Historial
    sessionService.addMessage(sessionId, "user", userMessage);
    const history = sessionService.getHistory(sessionId);

    // 3. IA
    const aiResponseRaw = await groqService.getChatResponse(history, knownName, {
      companyId,
    });
    console.log("🤖 Respuesta RAW de IA:", aiResponseRaw); // Para depuración

    let replyText = "";

    // 4. INTENTO DE PARSEO ROBUSTO
    const parsedData = extractJSON(aiResponseRaw);

    if (parsedData) {
      // ==========================================
      // SI ES UN JSON VÁLIDO (Acción o Mensaje)
      // ==========================================

      // CASO A: RESERVAR
      if (parsedData.action === "CREATE_BOOKING") {
        const requestedDate = parsedData.date;
        const requestedTime = normalizeTimeString(parsedData.time);
        const requestedCourt = (parsedData.courtName || "INDIFERENTE").trim();
        let requestedClientName = normalizeNameText(knownName || "");

        if (!requestedDate || !isValidIsoDate(requestedDate)) {
          replyText =
            "⚠️ Para reservar necesito la fecha en formato claro. Ejemplo: *2026-04-07* o decime *hoy/mañana*.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        if (!requestedTime) {
          replyText =
            "⚠️ Para reservar necesito la hora exacta. Ejemplo: *17:00*.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        if (!requestedClientName) {
          const extractedName = extractFullNameFromMessage(
            userMessage,
            parsedData.clientName,
          );
          if (extractedName) {
            requestedClientName = extractedName;
            await userService.saveOrUpdateUser(chatId, requestedClientName, {
              companyId,
              client,
            });
          }
        }

        if (!requestedClientName) {
          sessionService.updateMeta(sessionId, {
            awaitingFullNameForBooking: true,
            pendingBooking: {
              courtName: requestedCourt,
              dateStr: requestedDate,
              timeStr: requestedTime,
            },
          });
          replyText =
            "Antes de reservar, necesito tu *nombre completo* (ej: *Juan Pérez*). Te lo pido para dejar el turno a tu nombre y guardarte en la base de clientes.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        sessionService.updateMeta(sessionId, {
          awaitingFullNameForBooking: false,
          pendingBooking: null,
        });

        const bookingResult = await bookingService.createNewBooking({
          companyId,
          courtName: requestedCourt,
          dateStr: requestedDate,
          timeStr: requestedTime,
          clientName: requestedClientName,
          clientPhone: number,
        });

        replyText = buildBookingReplyText(
          requestedDate,
          requestedClientName,
          bookingResult,
        );
      }

      // CASO B: DISPONIBILIDAD
      else if (parsedData.action === "CHECK_AVAILABILITY") {
        const requestedDate = parsedData.date || getTodayIsoArgentina();
        const requestedTime = normalizeTimeString(parsedData.time);

        if (parsedData.date && !isValidIsoDate(parsedData.date)) {
          replyText =
            "⚠️ No pude entender la fecha. Decime por ejemplo *2026-04-07* o *hoy*.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        if (parsedData.time && !requestedTime) {
          replyText =
            "⚠️ No pude entender la hora exacta. Decime, por ejemplo, `17:00`.";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        const availability = await bookingService.getAvailableSlots(
          requestedDate,
          { companyId },
        );

        if (availability.success && availability.slots.length > 0) {
          if (requestedTime) {
            const exactMatch = availability.slots.find((s) => s.time === requestedTime);
            if (exactMatch) {
              replyText =
                `✅ Sí, tengo disponibilidad para el *${getFormattedDate(requestedDate)} a las ${requestedTime}*.\n` +
                `💰 Precio: $${exactMatch.price}\n\n` +
                `_¿Te lo reservo?_`;
            } else {
              const alternatives = availability.slots.slice(0, 5);
              const list = alternatives.map((s) => `• ${s.time} ($${s.price})`).join("\n");
              replyText =
                `🚫 No me queda disponible *${requestedTime}* para el ${getFormattedDate(requestedDate)}.\n\n` +
                (alternatives.length
                  ? `Te puedo ofrecer estos horarios:\n${list}\n\n_¿Cuál te reservo?_`
                  : "No me quedan horarios para esa fecha.");
            }
          } else {
            const lista = availability.slots
              .map((s) => `• ${s.time} ($${s.price})`)
              .join("\n");
            replyText = `📅 *Libres para el ${getFormattedDate(requestedDate)}:*\n\n${lista}\n\n_¿Cuál te reservo?_`;
          }
        } else {
          replyText = requestedTime
            ? `🚫 No tengo disponibilidad para el ${getFormattedDate(requestedDate)} a las ${requestedTime}.`
            : "🚫 Todo ocupado para esa fecha.";
        }
      }

      // CASO C: CANCELAR TURNO
      else if (parsedData.action === "CANCEL_BOOKING") {
        const requestedDate = parsedData.date;
        const requestedTime = normalizeTimeString(parsedData.time);

        if (!requestedDate || !isValidIsoDate(requestedDate) || !requestedTime) {
          replyText =
            "⚠️ Para cancelar necesito *fecha y hora exactas* del turno (ej: 2026-04-07 17:00).";
          sessionService.addMessage(sessionId, "assistant", replyText);
          return replyText;
        }

        const cancelResult = await bookingService.cancelBooking({
          companyId,
          clientPhone: number,
          dateStr: requestedDate,
          timeStr: requestedTime,
        });

        if (cancelResult.success) {
          let penaltyNote = "";
          if (cancelResult.nowSuspended) {
            penaltyNote =
              `\n\n⚠️ *Atención:* Has acumulado ${cancelResult.penalties} cancelaciones y tu cuenta ha sido *suspendida*. ` +
              `No podrás reservar nuevos turnos. Contactá a la administración para regularizar tu situación.`;
          } else if (cancelResult.penalties > 0) {
            const remaining =
              cancelResult.penaltyLimit - cancelResult.penalties;
            penaltyNote =
              `\n\n⚠️ _Aviso: Tenés ${cancelResult.penalties}/${cancelResult.penaltyLimit} cancelaciones. ` +
              `Con ${remaining} más, tu cuenta quedará suspendida._`;
          }

          replyText =
            `❌ *Turno Cancelado*\n\n` +
            `📅 *Fecha:* ${getFormattedDate(requestedDate)}\n` +
            `⏰ *Hora:* ${cancelResult.data.time}\n\n` +
            `_Tu turno fue cancelado correctamente. ¡Esperamos verte pronto! 👋_` +
            penaltyNote;
        } else {
          if (cancelResult.error === "NOT_FOUND")
            replyText =
              "⚠️ No encontré ningún turno tuyo para esa fecha y hora. ¿Me podés confirmar los datos?";
          else if (cancelResult.error === "INVALID_TIME")
            replyText = "⚠️ Ese horario no existe en la grilla.";
          else replyText = "⚠️ Hubo un error técnico al cancelar.";
        }
      }

      // CASO D: PEDIDO DE TURNO FIJO
      else if (parsedData.action === "FIXED_TURN_REQUEST") {
        const requestedDate = parsedData.date || "Sin fecha";
        const requestedTime = normalizeTimeString(parsedData.time) || "Sin horario";
        const summary = parsedData.message || userMessage;
        const requester = knownName || "Cliente no identificado";

        await sendAdminNotification(
          "fixed_turn_request",
          "Solicitud de Turno Fijo",
          `Cliente: ${requester}\nTeléfono: ${number}\nFecha: ${requestedDate}\nHora: ${requestedTime}\nDetalle: ${summary}`,
          { companyId, source: "whatsapp-fixed-turn" },
          { companyId },
        );

        replyText =
          "Perfecto. Ya le aviso al admin para que gestione ese *turno fijo* y te confirme por acá.";
      }

      // CASO E: SOLO MENSAJE (La IA respondió en JSON con campo "message")
      else if (parsedData.message) {
        replyText = parsedData.message;
      }

      // CASO F: JSON DESCONOCIDO
      else {
        const fallback = inferFallbackAction(userMessage);
        if (fallback?.action === "CHECK_AVAILABILITY") {
          const requestedDate = fallback.date || getTodayIsoArgentina();
          const requestedTime = normalizeTimeString(fallback.time);
          const availability = await bookingService.getAvailableSlots(
            requestedDate,
            { companyId },
          );

          if (availability.success && availability.slots.length > 0) {
            if (requestedTime) {
              const exactMatch = availability.slots.find((s) => s.time === requestedTime);
              if (exactMatch) {
                replyText =
                  `✅ Sí, tengo disponibilidad para el *${getFormattedDate(requestedDate)} a las ${requestedTime}*.\n` +
                  `💰 Precio: $${exactMatch.price}\n\n` +
                  `_¿Te lo reservo?_`;
              } else {
                const alternatives = availability.slots.slice(0, 5);
                const list = alternatives.map((s) => `• ${s.time} ($${s.price})`).join("\n");
                replyText =
                  `🚫 No me queda disponible *${requestedTime}* para el ${getFormattedDate(requestedDate)}.\n\n` +
                  (alternatives.length
                    ? `Te puedo ofrecer estos horarios:\n${list}\n\n_¿Cuál te reservo?_`
                    : "No me quedan horarios para esa fecha.");
              }
            } else {
              const lista = availability.slots
                .map((s) => `• ${s.time} ($${s.price})`)
                .join("\n");
              replyText = `📅 *Libres para el ${getFormattedDate(requestedDate)}:*\n\n${lista}\n\n_¿Cuál te reservo?_`;
            }
          } else {
            replyText = requestedTime
              ? `🚫 No tengo disponibilidad para el ${getFormattedDate(requestedDate)} a las ${requestedTime}.`
              : "🚫 Todo ocupado para esa fecha.";
          }
        } else if (fallback?.action === "FIXED_TURN_REQUEST") {
          const requestedDate = fallback.date || "Sin fecha";
          const requestedTime = normalizeTimeString(fallback.time) || "Sin horario";
          const requester = knownName || "Cliente no identificado";

          await sendAdminNotification(
            "fixed_turn_request",
            "Solicitud de Turno Fijo",
            `Cliente: ${requester}\nTeléfono: ${number}\nFecha: ${requestedDate}\nHora: ${requestedTime}\nDetalle: ${userMessage}`,
            { companyId, source: "whatsapp-fixed-turn-fallback" },
            { companyId },
          );

          replyText =
            "Perfecto. Ya le aviso al admin para que gestione ese *turno fijo* y te confirme por acá.";
        } else {
          replyText = "No entendí la respuesta del sistema.";
        }
      }
    } else {
      // ==========================================
      // SI NO ES JSON (Texto plano o error)
      // ==========================================
      const fallback = inferFallbackAction(userMessage);

      if (fallback?.action === "CHECK_AVAILABILITY") {
        const requestedDate = fallback.date || getTodayIsoArgentina();
        const requestedTime = normalizeTimeString(fallback.time);
        const availability = await bookingService.getAvailableSlots(
          requestedDate,
          { companyId },
        );

        if (availability.success && availability.slots.length > 0) {
          if (requestedTime) {
            const exactMatch = availability.slots.find((s) => s.time === requestedTime);
            if (exactMatch) {
              replyText =
                `✅ Sí, tengo disponibilidad para el *${getFormattedDate(requestedDate)} a las ${requestedTime}*.\n` +
                `💰 Precio: $${exactMatch.price}\n\n` +
                `_¿Te lo reservo?_`;
            } else {
              const alternatives = availability.slots.slice(0, 5);
              const list = alternatives.map((s) => `• ${s.time} ($${s.price})`).join("\n");
              replyText =
                `🚫 No me queda disponible *${requestedTime}* para el ${getFormattedDate(requestedDate)}.\n\n` +
                (alternatives.length
                  ? `Te puedo ofrecer estos horarios:\n${list}\n\n_¿Cuál te reservo?_`
                  : "No me quedan horarios para esa fecha.");
            }
          } else {
            const lista = availability.slots
              .map((s) => `• ${s.time} ($${s.price})`)
              .join("\n");
            replyText = `📅 *Libres para el ${getFormattedDate(requestedDate)}:*\n\n${lista}\n\n_¿Cuál te reservo?_`;
          }
        } else {
          replyText = requestedTime
            ? `🚫 No tengo disponibilidad para el ${getFormattedDate(requestedDate)} a las ${requestedTime}.`
            : "🚫 Todo ocupado para esa fecha.";
        }
      } else if (fallback?.action === "FIXED_TURN_REQUEST") {
        const requestedDate = fallback.date || "Sin fecha";
        const requestedTime = normalizeTimeString(fallback.time) || "Sin horario";
        const requester = knownName || "Cliente no identificado";

        await sendAdminNotification(
          "fixed_turn_request",
          "Solicitud de Turno Fijo",
          `Cliente: ${requester}\nTeléfono: ${number}\nFecha: ${requestedDate}\nHora: ${requestedTime}\nDetalle: ${userMessage}`,
          { companyId, source: "whatsapp-fixed-turn-fallback" },
          { companyId },
        );

        replyText =
          "Perfecto. Ya le aviso al admin para que gestione ese *turno fijo* y te confirme por acá.";
      } else {
        // Limpiamos posibles backticks de markdown por si acaso
        replyText = aiResponseRaw
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();
      }
    }

    // 5. Enviar y Guardar
    sessionService.addMessage(sessionId, "assistant", replyText);
    return replyText;
  } catch (error) {
    console.error("❌ Error en messageHandler:", error);
    return "Tuve un error procesando tu mensaje.";
  }
};

module.exports = { handleIncomingMessage };

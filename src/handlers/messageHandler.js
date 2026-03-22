const groqService = require("../services/groqService");
const sessionService = require("../services/sessionService");
const bookingService = require("../services/bookingService");
const userService = require("../services/userService");
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

const handleIncomingMessage = async (chatId, userMessage) => {
  try {
    // 1. Identificar Usuario
    const registeredUser = await userService.getUserByWhatsappId(chatId);
    const knownName = registeredUser ? registeredUser.name : null;
    const number = await getNumberByUser(chatId);
    console.log(`👤 Mensaje de: ${knownName || chatId}`);
    console.log(`📞 Número de WhatsApp: ${number}`);

    // 2. Historial
    sessionService.addMessage(chatId, "user", userMessage);
    const history = sessionService.getHistory(chatId);

    // 3. IA
    const aiResponseRaw = await groqService.getChatResponse(history, knownName);
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
        if (parsedData.clientName) {
          await userService.saveOrUpdateUser(chatId, parsedData.clientName);
        }

        const bookingResult = await bookingService.createNewBooking({
          courtName: parsedData.courtName,
          dateStr: parsedData.date,
          timeStr: parsedData.time,
          clientName: parsedData.clientName || knownName,
          clientPhone: number,
        });

        if (bookingResult.success) {
          replyText =
            `✅ *¡Reserva Confirmada!* 🎾\n\n` +
            `👤 *Jugador:* ${bookingResult.data.clientName || parsedData.clientName}\n` +
            `📌 *Cancha:* ${bookingResult.data.courtName}\n` +
            `📅 *Fecha:* ${getFormattedDate(parsedData.date)}\n` +
            `⏰ *Hora:* ${bookingResult.data.startTime} - ${bookingResult.data.endTime}\n` +
            `💰 *Precio:* $${bookingResult.data.price}`;
        } else {
          if (bookingResult.error === "BUSY")
            replyText = "🚫 Ese turno ya está ocupado. ¿Te busco otro?";
          else if (bookingResult.error === "INVALID_TIME")
            replyText = "⚠️ Ese horario no existe en la grilla.";
          else if (bookingResult.error === "SUSPENDED")
            replyText =
              `🚫 *Tu cuenta está suspendida.*\n\n` +
              `Has acumulado demasiadas cancelaciones y no podés reservar nuevos turnos por el momento.\n` +
              `Contactá a la administración del club para regularizar tu situación.`;
          else replyText = "⚠️ Hubo un error técnico al reservar.";
        }
      }

      // CASO B: DISPONIBILIDAD
      else if (parsedData.action === "CHECK_AVAILABILITY") {
        const availability = await bookingService.getAvailableSlots(
          parsedData.date,
        );
        if (availability.success && availability.slots.length > 0) {
          const lista = availability.slots
            .map((s) => `• ${s.time} ($${s.price})`)
            .join("\n");
          replyText = `📅 *Libres para el ${parsedData.date}:*\n\n${lista}\n\n_¿Cuál te reservo?_`;
        } else {
          replyText = "🚫 Todo ocupado para esa fecha.";
        }
      }

      // CASO C: CANCELAR TURNO
      else if (parsedData.action === "CANCEL_BOOKING") {
        const cancelResult = await bookingService.cancelBooking({
          clientPhone: number,
          dateStr: parsedData.date,
          timeStr: parsedData.time,
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
            `📅 *Fecha:* ${getFormattedDate(parsedData.date)}\n` +
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

      // CASO D: SOLO MENSAJE (La IA respondió en JSON con campo "message")
      else if (parsedData.message) {
        replyText = parsedData.message;
      }

      // CASO E: JSON DESCONOCIDO
      else {
        replyText = "No entendí la respuesta del sistema.";
      }
    } else {
      // ==========================================
      // SI NO ES JSON (Texto plano o error)
      // ==========================================
      // Limpiamos posibles backticks de markdown por si acaso
      replyText = aiResponseRaw
        .replace(/```json/g, "")
        .replace(/```/g, "")
        .trim();
    }

    // 5. Enviar y Guardar
    sessionService.addMessage(chatId, "assistant", replyText);
    return replyText;
  } catch (error) {
    console.error("❌ Error en messageHandler:", error);
    return "Tuve un error procesando tu mensaje.";
  }
};

module.exports = { handleIncomingMessage };

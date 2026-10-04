'use strict';

const { INTENTS } = require('./messageInterpreter');
const { getFormattedDate } = require('../../utils/getFormattedDate');

const DAY_NAMES_ES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

const buildAntiLoopReply = ({ interpretation = {}, sessionMeta = {} } = {}) => {
  const missingName = sessionMeta.awaitingFullNameForBooking;
  const missingConfirmation = sessionMeta.pendingBookingOffer?.dateStr && sessionMeta.pendingBookingOffer?.timeStr;
  const intent = interpretation?.detectedIntent || INTENTS.UNKNOWN;

  if (missingName) {
    return "Sigo esperando tu *nombre y apellido* para avanzar con la reserva. Ejemplo: *Juan Pérez*.";
  }
  if (missingConfirmation) {
    return "Para avanzar, decime solo una opción: *CONFIRMAR RESERVA* o *CANCELAR*.";
  }
  if (intent === INTENTS.CONFIRM && !missingConfirmation) {
    return "No tenés ningún turno pendiente de confirmar. ¿Querés reservar uno? Decime *fecha y hora* (ej: hoy 20:00).";
  }
  if (intent === INTENTS.CREATE_BOOKING) {
    return "Entendido. Para reservar sin errores necesito *fecha y hora* (ej: hoy 20:00).";
  }
  if (intent === INTENTS.CANCEL_BOOKING) {
    return "Para cancelar tu turno, pasame la *fecha y hora* (ej: mañana 20:00).";
  }
  return "Te estoy entendiendo, pero para avanzar necesito un dato más concreto.";
};

const buildBookingReplyText = (requestedDate, requestedClientName, bookingResult) => {
  if (bookingResult.success) {
    return (
      `✅ *¡Reserva Confirmada!* 🎾\n\n` +
      `👤 *Jugador:* ${requestedClientName}\n` +
      `📌 *Cancha:* ${bookingResult.data.courtName}${bookingResult.data.courtType ? ` (${bookingResult.data.courtType})` : ""}\n` +
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
  if (bookingResult.error === "ALREADY_BOOKED") {
    return (
      `ℹ️ Ya tenés una reserva activa para el *${getFormattedDate(requestedDate)}* a las *${bookingResult.data?.startTime || "ese horario"}*.\n\n` +
      `Si querés otra cancha u otro horario, decime y te ayudo.`
    );
  }
  if (bookingResult.error === "DAILY_LIMIT_REACHED") {
    const limit = bookingResult?.data?.limit || 0;
    return `⚠️ Ya alcanzaste el límite de ${limit} reservas para el ${getFormattedDate(requestedDate)}.`;
  }
  return "⚠️ Hubo un error técnico al reservar.";
};

const buildSecondBookingConfirmationText = () =>
  "Ya tenés una reserva activa. Para continuar sin errores, respondé *CONFIRMAR EXTRA* o *CANCELAR*.";

const buildActiveBookingsReply = (bookings = []) => {
  if (!Array.isArray(bookings) || bookings.length === 0) {
    return "📭 No encontré reservas vigentes para este número de WhatsApp.";
  }

  const lines = bookings.map((booking, index) => {
    const timeText = booking.endTime
      ? `${booking.startTime} - ${booking.endTime}`
      : booking.startTime;

    if (booking.type === "fixed") {
      const dayName = DAY_NAMES_ES[booking.dayOfWeek] || "?";
      return (
        `${index + 1}) 📌 ${booking.courtName}\n` +
        `   🔁 Todos los ${dayName}\n` +
        `   ⏰ ${timeText}`
      );
    }

    const dateText = getFormattedDate(booking.date);
    return (
      `${index + 1}) 📅 ${dateText}\n` +
      `   ⏰ ${timeText}\n` +
      `   📌 ${booking.courtName}`
    );
  });

  return `🎾 *Estas son tus reservas vigentes:*\n\n${lines.join("\n\n")}`;
};

module.exports = {
  buildAntiLoopReply,
  buildBookingReplyText,
  buildSecondBookingConfirmationText,
  buildActiveBookingsReply,
};
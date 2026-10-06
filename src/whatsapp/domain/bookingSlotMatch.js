'use strict';

const { getFormattedDate } = require("../../utils/getFormattedDate");

const DAY_NAMES_ES = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

const STATUS_LABELS = {
  confirmado: "✅ Estado: Confirmada",
  reservado: "⏳ Estado: Reservada (pendiente de confirmación)",
  suspendido: "🚫 Estado: Suspendida",
};

const toMinutes = (value = "") => {
  const [hours = "0", minutes = "0"] = String(value).split(":");
  const h = Number.parseInt(hours, 10);
  const m = Number.parseInt(minutes, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

// El cliente pidió las "18:30" y su reserva empieza a las 18:00
// (slot 18:00-19:00): la hora pedida cae dentro del rango del turno.
const isTimeWithinSlot = ({ requestedTime = "", startTime = "", endTime = "" } = {}) => {
  const requested = toMinutes(requestedTime);
  const start = toMinutes(startTime);
  if (requested === null || start === null) return false;
  const end = endTime ? toMinutes(endTime) : start + 60;
  return requested >= start && requested < end;
};

const getWeekdayIndexFromIsoDate = (date = "") => {
  const [year, month, day] = String(date).split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
};

// Encuentra la reserva vigente del cliente que ocupa la fecha y hora
// pedidas. Coincide por: misma fecha ISO + hora dentro del slot
// (mismo startTime o dentro de [startTime, endTime)). Los turnos fijos
// coinciden por día de semana + hora.
const findActiveBookingForRequestedSlot = ({
  activeBookings = [],
  date = "",
  time = "",
} = {}) => {
  if (!Array.isArray(activeBookings) || !date || !time) return null;
  const requestedTime = String(time);

  for (const booking of activeBookings) {
    if (!booking?.startTime) continue;
    const timeMatches = isTimeWithinSlot({
      requestedTime,
      startTime: booking.startTime,
      endTime: booking.endTime,
    });
    if (!timeMatches) continue;

    if (booking.type === "fixed") {
      if (booking.dayOfWeek === getWeekdayIndexFromIsoDate(date)) return booking;
      continue;
    }

    if (booking.date === date) return booking;
  }
  return null;
};

// Respuesta con el estado de la reserva existente: fecha legible,
// cancha, hora y estado. Reemplaza a sugerir canchas o a pedir datos
// para agendar cuando el cliente ya tiene ese turno.
const buildExistingBookingStatusReply = (booking = {}) => {
  const timeText = booking.endTime
    ? `${booking.startTime} - ${booking.endTime}`
    : booking.startTime;

  const when =
    booking.type === "fixed"
      ? `🔁 Todos los ${DAY_NAMES_ES[booking.dayOfWeek] || "?"}`
      : `📅 ${getFormattedDate(booking.date)}`;

  const status = STATUS_LABELS[booking.status] || STATUS_LABELS.confirmado;
  const payment =
    booking.paymentStatus === "pendiente" ? "\n💳 Pago pendiente" : "";

  return (
    `🎾 *Ya tenés una reserva para esa fecha y hora:*\n\n` +
    `${when}\n` +
    `⏰ ${timeText}\n` +
    `📌 ${booking.courtName}\n` +
    `${status}${payment}`
  );
};

module.exports = {
  isTimeWithinSlot,
  findActiveBookingForRequestedSlot,
  buildExistingBookingStatusReply,
};
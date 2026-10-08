'use strict';

// WhatsApp confirmation for bookings created from the public web portal.
//
// The message builder is a pure function (same input -> same output) so the
// copy can be tested without touching the queue. The sender is best-effort:
// it never throws, so a transient Redis/queue failure cannot roll back a
// booking that was already persisted.

const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require("./whatsappCommandQueue.service");
const { getFormattedDate } = require("../utils/getFormattedDate");

const buildBookingWhatsappConfirmation = ({ client, court, slot, date }) => {
  const clientName = client?.name || "";
  const courtName = court?.name || "";
  const startTime = slot?.startTime || "";
  const endTime = slot?.endTime || "";
  const price = slot?.price ?? 0;

  return (
    `✅ *¡Tu turno está confirmado!* 🎾\n\n` +
    `👤 *${clientName}*\n` +
    `📌 *Cancha:* ${courtName}\n` +
    `📅 *Fecha:* ${getFormattedDate(date)}\n` +
    `⏰ *Hora:* ${startTime} a ${endTime}\n` +
    `💰 *Total:* $${price}\n\n` +
    `¡Te esperamos en el club! 🏸`
  );
};

// Pure builder for the "pending seña" message. `deposit.initPoint` is the
// MercadoPago Checkout Pro link; when it is absent the message still states the
// seña amount so the client can be instructed to reopen the booking.
const buildDepositPaymentMessage = ({ client, court, slot, date, deposit }) => {
  const clientName = client?.name || "";
  const courtName = court?.name || "";
  const startTime = slot?.startTime || "";
  const endTime = slot?.endTime || "";
  const amount = deposit?.amount ?? 0;
  const paymentLink = deposit?.initPoint || "";

  const lines = [
    `🎾 *¡Ya casi es tuyo! Falta la seña*`,
    ``,
    `👤 *${clientName}*`,
    `📌 *Cancha:* ${courtName}`,
    `📅 *Fecha:* ${getFormattedDate(date)}`,
    `⏰ *Hora:* ${startTime}${endTime ? ` a ${endTime}` : ""}`,
    `💰 *Seña:* $${amount}`,
  ];

  if (paymentLink) {
    lines.push(``, `💳 Pagá tu seña acá: ${paymentLink}`);
  }

  return lines.join("\n");
};

const sendBookingWhatsappConfirmation = async ({
  companyId = null,
  clientPhone,
  client,
  court,
  slot,
  date,
  requestedBy = null,
  enqueue = enqueueWhatsappCommand,
}) => {
  try {
    const message = buildBookingWhatsappConfirmation({ client, court, slot, date });

    const result = await enqueue({
      companyId,
      type: COMMAND_TYPES.SEND_MESSAGE,
      payload: { to: clientPhone, message },
      requestedBy,
    });

    return { ok: true, message, command: result?.command || null };
  } catch (error) {
    console.error(
      "[BookingWhatsappConfirmation] No se pudo encolar la confirmación:",
      error?.message || error,
    );
    return { ok: false, message: null, error };
  }
};

module.exports = {
  buildBookingWhatsappConfirmation,
  buildDepositPaymentMessage,
  sendBookingWhatsappConfirmation,
};

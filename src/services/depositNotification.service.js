'use strict';

// Deposit notifications: admin in-app/WhatsApp alerts plus client WhatsApp
// messages for the pending/paid/expired deposit events. Reuses
// `notificationService.sendAdminNotification` and `enqueueWhatsappCommand`.
// Services are injectable (`deps`) so the notifiers can be tested without a
// queue, a database or a live WhatsApp worker. All enqueues are best-effort:
// a transient queue failure never throws back into the booking/webhook flow.

const notificationService = require('./notificationService');
const whatsappCommandQueue = require('./whatsappCommandQueue.service');
const {
  buildDepositPaymentMessage,
} = require('./bookingWhatsappConfirmation.service');
const { formatBookingDateShort } = require('../utils/formatBookingDateShort');
const {
  normalizeCanonicalClientPhone,
} = require('../utils/identityNormalization');

const NOTIFICATION_TYPES = {
  PENDING: 'deposit_pending',
  PAID: 'deposit_paid',
  EXPIRED: 'deposit_expired',
};

const resolveDeps = (deps = {}) => ({
  sendAdminNotification:
    deps.sendAdminNotification || notificationService.sendAdminNotification,
  enqueueWhatsappCommand:
    deps.enqueueWhatsappCommand || whatsappCommandQueue.enqueueWhatsappCommand,
});

const buildClientChatId = (rawPhone) => {
  const digits = normalizeCanonicalClientPhone(rawPhone);
  if (!digits) return '';
  return `${digits}@c.us`;
};

const enqueueClientMessage = async ({ companyId, phone, message, enqueue }) => {
  const chatId = buildClientChatId(phone);
  if (!chatId) return null;
  try {
    await enqueue({
      companyId,
      type: whatsappCommandQueue.COMMAND_TYPES.SEND_MESSAGE,
      payload: { to: chatId, message },
    });
    return chatId;
  } catch (error) {
    console.error(
      '[DepositNotification] No se pudo encolar el mensaje al cliente:',
      error?.message || error,
    );
    return null;
  }
};

const notifyDepositPending = async (
  { booking, companyId = null, initPoint = '' },
  deps = {},
) => {
  const { sendAdminNotification, enqueueWhatsappCommand: enqueue } = resolveDeps(deps);
  const amount = booking?.deposit?.amount ?? 0;

  await sendAdminNotification(
    NOTIFICATION_TYPES.PENDING,
    'Reserva con seña pendiente',
    `Cliente: ${booking?.clientName || 'N/D'}\nFecha: ${formatBookingDateShort(
      booking?.date,
    )}\nSeña: $${amount}`,
    { bookingId: booking?._id, companyId },
    { companyId },
  );

  const message = buildDepositPaymentMessage({
    client: { name: booking?.clientName },
    court: booking?.court,
    slot: booking?.timeSlot,
    date: booking?.date,
    deposit: { amount, initPoint },
  });
  const chatId = await enqueueClientMessage({
    companyId,
    phone: booking?.clientPhone,
    message,
    enqueue,
  });

  return { notified: true, chatId };
};

const notifyDepositPaid = async ({ booking, companyId = null }, deps = {}) => {
  const { sendAdminNotification, enqueueWhatsappCommand: enqueue } = resolveDeps(deps);

  await sendAdminNotification(
    NOTIFICATION_TYPES.PAID,
    'Seña pagada',
    `Cliente: ${booking?.clientName || 'N/D'}\nFecha: ${formatBookingDateShort(
      booking?.date,
    )}\nSeña: $${booking?.deposit?.amount ?? 0}\nLa reserva quedó confirmada.`,
    { bookingId: booking?._id, companyId },
    { companyId },
  );

  const chatId = await enqueueClientMessage({
    companyId,
    phone: booking?.clientPhone,
    message: `✅ *¡Seña acreditada!* Tu turno quedó confirmado. 🎾`,
    enqueue,
  });

  return { notified: true, chatId };
};

const notifyDepositExpired = async ({ booking, companyId = null }, deps = {}) => {
  const { sendAdminNotification, enqueueWhatsappCommand: enqueue } = resolveDeps(deps);

  await sendAdminNotification(
    NOTIFICATION_TYPES.EXPIRED,
    'Seña vencida',
    `Cliente: ${booking?.clientName || 'N/D'}\nFecha: ${formatBookingDateShort(
      booking?.date,
    )}\nNo se acreditó la seña a tiempo; el turno fue liberado.`,
    { bookingId: booking?._id, companyId },
    { companyId },
  );

  const chatId = await enqueueClientMessage({
    companyId,
    phone: booking?.clientPhone,
    message: `⌛ *Tu seña venció.* El turno quedó liberado. Podés volver a reservar cuando quieras. 🎾`,
    enqueue,
  });

  return { notified: true, chatId };
};

module.exports = {
  NOTIFICATION_TYPES,
  buildClientChatId,
  notifyDepositExpired,
  notifyDepositPaid,
  notifyDepositPending,
};

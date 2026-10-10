'use strict';

// Deposit notifications: admin in-app/WhatsApp alerts plus client WhatsApp
// messages for the pending/paid/expired deposit events. Reuses
// `notificationService.sendAdminNotification` and `enqueueWhatsappCommand`.
// Services are injectable (`deps`) so the notifiers can be tested without a
// queue, a database or a live WhatsApp worker. Every side effect is best-effort
// and INDEPENDENT: a failing admin alert must never suppress the client message
// (and vice versa), and a failure never throws back into the booking flow.

const Booking = require('../models/booking.model');
const notificationService = require('./notificationService');
const whatsappCommandQueue = require('./whatsappCommandQueue.service');
const {
  buildBookingWhatsappConfirmation,
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
  LATE_PAYMENT: 'deposit_late_payment',
  AMOUNT_MISMATCH: 'deposit_amount_mismatch',
};

// Short confirmation kept as the fallback: the client must never be left
// without a paid-ticket message, even when the full details cannot be resolved.
const PAID_FALLBACK_MESSAGE = `✅ *¡Seña acreditada!* Tu turno quedó confirmado. 🎾`;

const toIsoDateOnly = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return date.toISOString().slice(0, 10);
};

// The approval webhook passes the raw updated booking (court/timeSlot are
// ObjectIds). The confirmation builder needs the populated court (`.name`) and
// timeSlot (`.startTime`/`.endTime`/`.price`), so resolve them before rendering.
// Persistence is injectable: tests can substitute a resolver that never touches
// the database. Never throws — returns `null` so the caller falls back.
const defaultResolvePopulatedBooking = async (booking) => {
  if (!booking) return null;
  // Already resolved (portal path): skip the round-trip entirely.
  if (
    booking.court &&
    typeof booking.court === 'object' &&
    booking.court.name &&
    booking.timeSlot &&
    typeof booking.timeSlot === 'object' &&
    booking.timeSlot.startTime
  ) {
    return booking;
  }
  if (!booking._id) return null;
  // Guard: never buffer against a disconnected Mongoose (would stall ~10s and
  // then throw). When Mongo is not connected, fall back instead of hanging.
  if (Booking?.db?.readyState !== 1) return null;
  try {
    const populated = await Booking.findById(booking._id)
      .populate('court timeSlot')
      .lean();
    return populated || null;
  } catch (error) {
    console.error(
      '[DepositNotification] no se pudieron resolver court/timeSlot del turno pagado:',
      error?.message || error,
    );
    return null;
  }
};

const resolveDeps = (deps = {}) => ({
  sendAdminNotification:
    deps.sendAdminNotification || notificationService.sendAdminNotification,
  enqueueWhatsappCommand:
    deps.enqueueWhatsappCommand || whatsappCommandQueue.enqueueWhatsappCommand,
  resolvePopulatedBooking:
    deps.resolvePopulatedBooking || defaultResolvePopulatedBooking,
});

// Runs a best-effort side effect, never throwing. Each side effect in a notifier
// runs through this so one failing channel cannot suppress the others.
const runSafe = async (label, fn) => {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (error) {
    console.error(
      `[DepositNotification] ${label} failed:`,
      error?.message || error,
    );
    return { ok: false, error };
  }
};

const buildClientChatId = (rawPhone) => {
  const digits = normalizeCanonicalClientPhone(rawPhone);
  if (!digits) return '';
  return `${digits}@c.us`;
};

const enqueueClientMessage = async ({ companyId, phone, message, enqueue }) => {
  const chatId = buildClientChatId(phone);
  if (!chatId) return null;
  const result = await runSafe('client whatsapp enqueue', () =>
    enqueue({
      companyId,
      type: whatsappCommandQueue.COMMAND_TYPES.SEND_MESSAGE,
      payload: { to: chatId, message },
    }),
  );
  return result.ok ? chatId : null;
};

const notifyDepositPending = async (
  { booking, companyId = null, initPoint = '', notifyClient = true },
  deps = {},
) => {
  const { sendAdminNotification, enqueueWhatsappCommand: enqueue } = resolveDeps(deps);
  const amount = booking?.deposit?.amount ?? 0;

  const adminResult = await runSafe('deposit_pending admin', () =>
    sendAdminNotification(
      NOTIFICATION_TYPES.PENDING,
      'Reserva con seña pendiente',
      `Cliente: ${booking?.clientName || 'N/D'}\nFecha: ${formatBookingDateShort(
        booking?.date,
      )}\nSeña: $${amount}`,
      { bookingId: booking?._id, companyId },
      { companyId },
    ),
  );

  // The bot path already carries the Checkout Pro link in the chat reply, so it
  // opts out of the queued client message to avoid delivering the link twice.
  // The portal path still needs the enqueued client message.
  if (!notifyClient) {
    return { notified: true, adminNotified: adminResult.ok, chatId: null };
  }

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

  return { notified: true, adminNotified: adminResult.ok, chatId };
};

const notifyDepositPaid = async ({ booking, companyId = null }, deps = {}) => {
  const {
    sendAdminNotification,
    enqueueWhatsappCommand: enqueue,
    resolvePopulatedBooking,
  } = resolveDeps(deps);

  const adminResult = await runSafe('deposit_paid admin', () =>
    sendAdminNotification(
      NOTIFICATION_TYPES.PAID,
      'Seña pagada',
      `Cliente: ${booking?.clientName || 'N/D'}\nFecha: ${formatBookingDateShort(
        booking?.date,
      )}\nSeña: $${booking?.deposit?.amount ?? 0}\nLa reserva quedó confirmada.`,
      { bookingId: booking?._id, companyId },
      { companyId },
    ),
  );

  // The webhook passes the raw booking (court/timeSlot are ObjectIds); resolve
  // them so the client confirmation carries the full turn details. Robustness:
  // if the resolve fails or leaves the fields unresolved, fall back to the
  // short generic message — the client is never left without a confirmation.
  const resolved = await runSafe('deposit_paid client details', () =>
    resolvePopulatedBooking(booking),
  );
  const target = (resolved.ok && resolved.value) || booking || {};

  const court = target.court && typeof target.court === 'object' ? target.court : null;
  const slot = target.timeSlot && typeof target.timeSlot === 'object' ? target.timeSlot : null;
  const canRenderFull = Boolean(
    court?.name && slot?.startTime && slot?.endTime,
  );

  const message = canRenderFull
    ? buildBookingWhatsappConfirmation({
        client: { name: target.clientName },
        court,
        slot,
        date: toIsoDateOnly(target.date),
      })
    : PAID_FALLBACK_MESSAGE;

  const chatId = await enqueueClientMessage({
    companyId,
    phone: booking?.clientPhone,
    message,
    enqueue,
  });

  return { notified: true, adminNotified: adminResult.ok, chatId };
};

const notifyDepositExpired = async ({ booking, companyId = null }, deps = {}) => {
  const { sendAdminNotification, enqueueWhatsappCommand: enqueue } = resolveDeps(deps);

  const adminResult = await runSafe('deposit_expired admin', () =>
    sendAdminNotification(
      NOTIFICATION_TYPES.EXPIRED,
      'Seña vencida',
      `Cliente: ${booking?.clientName || 'N/D'}\nFecha: ${formatBookingDateShort(
        booking?.date,
      )}\nNo se acreditó la seña a tiempo; el turno fue liberado.`,
      { bookingId: booking?._id, companyId },
      { companyId },
    ),
  );

  const chatId = await enqueueClientMessage({
    companyId,
    phone: booking?.clientPhone,
    message: `⌛ *Tu seña venció.* El turno quedó liberado. Podés volver a reservar cuando quieras. 🎾`,
    enqueue,
  });

  return { notified: true, adminNotified: adminResult.ok, chatId };
};

// A payment approved after the hold died: the money is captured but the court is
// gone, so this needs MANUAL review/refund. Admin-only — the client already got
// the expiry message; no confirmation is sent.
const notifyDepositLatePayment = async (
  { booking, companyId = null, bookingId = null, paymentId = null },
  deps = {},
) => {
  const { sendAdminNotification } = resolveDeps(deps);
  const resolvedBookingId = booking?._id || bookingId;

  const adminResult = await runSafe('deposit_late_payment admin', () =>
    sendAdminNotification(
      NOTIFICATION_TYPES.LATE_PAYMENT,
      'Pago recibido fuera de término',
      `Cliente: ${booking?.clientName || 'N/D'}\nFecha: ${formatBookingDateShort(
        booking?.date,
      )}\nPago: ${paymentId || 'N/D'}\nEl pago se acreditó DESPUÉS de liberarse el turno. Revisar y reembolsar si corresponde.`,
      { bookingId: resolvedBookingId, paymentId, companyId },
      { companyId },
    ),
  );

  return { notified: true, adminNotified: adminResult.ok, reviewRequired: true };
};

// The captured amount does not match the configured seña: do not confirm;
// admin-only review notification.
const notifyDepositAmountMismatch = async (
  { booking, companyId = null, bookingId = null, paymentId = null, expected = null, received = null },
  deps = {},
) => {
  const { sendAdminNotification } = resolveDeps(deps);
  const resolvedBookingId = booking?._id || bookingId;

  const adminResult = await runSafe('deposit_amount_mismatch admin', () =>
    sendAdminNotification(
      NOTIFICATION_TYPES.AMOUNT_MISMATCH,
      'Monto de seña no coincide',
      `Cliente: ${booking?.clientName || 'N/D'}\nPago: ${paymentId || 'N/D'}\nEsperado: $${expected ?? 'N/D'}\nRecibido: $${received ?? 'N/D'}\nNo se confirmó la reserva; revisar manualmente.`,
      { bookingId: resolvedBookingId, paymentId, expected, received, companyId },
      { companyId },
    ),
  );

  return { notified: true, adminNotified: adminResult.ok, reviewRequired: true };
};

module.exports = {
  NOTIFICATION_TYPES,
  buildClientChatId,
  notifyDepositAmountMismatch,
  notifyDepositExpired,
  notifyDepositLatePayment,
  notifyDepositPaid,
  notifyDepositPending,
};

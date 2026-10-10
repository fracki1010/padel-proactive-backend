'use strict';

// WhatsApp receipt verification: when a client sends a payment receipt (image or
// PDF) for a transfer seña, this handler reads it, validates bank + exact amount
// + time window, and — if everything matches — auto-confirms the booking through
// the SAME atomic transition as the admin manual confirmation, firing the full
// WhatsApp confirmation and an explicit "seña verificada" reply.
//
// Every side effect is INJECTABLE via `deps` so the decision logic can be tested
// without a DB, queue, or network. The handler never throws: the webhook path
// must stay resilient. Persistence for the pending-booking lookup is injectable
// (`deps.model`) so it can be exercised with an in-memory stand-in.

const Booking = require('../models/booking.model');
const receiptReader = require('./receiptReader.service');
const depositService = require('./deposit.service');
const { getNumberByUser } = require('../utils/getNumberByUser');
const { normalizeCanonicalClientPhone } = require('../utils/identityNormalization');
const { sendAdminNotification } = require('./notificationService');

const NO_PENDING_REPLY = 'No tenés un turno pendiente de seña.';
const CONFIRMED_REPLY = '✅ *Seña verificada.* ¡Tu turno quedó confirmado! 🎾';
const INVALID_NOTIFICATION_TYPE = 'deposit_receipt_invalid';

const buildInvalidReply = (reasons = []) => {
  const detail =
    Array.isArray(reasons) && reasons.length
      ? reasons.join(' / ')
      : 'no se pudo leer el comprobante';
  return `❌ No pudimos verificar el comprobante: ${detail}. Envialo de nuevo o escribí al club.`;
};

const runSafe = async (label, fn) => {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    console.error(`[ReceiptVerification] ${label} failed:`, error?.message || error);
    return { ok: false, error };
  }
};

// Most recent pending transfer seña for the client (by phone or WhatsApp id),
// scoped to the company. Returns null when the client has no live hold.
const findPendingTransferBooking = async (
  { companyId = null, chatId = '', phone = '' } = {},
  options = {},
) => {
  const model = (options && options.model) || Booking;
  const cleanPhone = String(phone || '').trim();
  const cleanChatId = String(chatId || '').trim();

  const orClauses = [];
  if (cleanPhone) orClauses.push({ clientPhone: cleanPhone });
  if (cleanChatId) orClauses.push({ clientWhatsappId: cleanChatId });
  if (!orClauses.length) return null;

  const filter = {
    companyId: companyId || null,
    status: 'pendiente_seña',
    'deposit.method': 'transfer',
    'deposit.status': 'pendiente',
  };
  if (orClauses.length === 1) Object.assign(filter, orClauses[0]);
  else filter.$or = orClauses;

  const query = model.findOne(filter).sort({ createdAt: -1 });
  return typeof query.lean === 'function' ? query.lean() : query;
};

const notifyInvalidReceipt = async (deps, { companyId, booking, phone, reasons }) => {
  const notify = deps.sendAdminNotification || sendAdminNotification;
  await runSafe('invalid receipt admin notification', () =>
    notify(
      INVALID_NOTIFICATION_TYPE,
      'Comprobante de seña no verificado',
      `Cliente: ${booking?.clientName || 'N/D'}\n` +
        `Teléfono: ${phone || 'N/D'}\n` +
        `Seña esperada: $${booking?.deposit?.amount ?? 'N/D'}\n` +
        `Motivos: ${reasons.join(' / ')}\n` +
        'La reserva sigue pendiente de seña.',
      { bookingId: booking?._id, companyId, reasons },
      { companyId },
    ),
  );
};

const handleIncomingReceipt = async (
  { companyId = null, from = '', media = null } = {},
  deps = {},
) => {
  const chatId = String(from || '').trim();

  const resolvePhone = deps.getNumberByUser || getNumberByUser;
  const phoneResult = await runSafe('resolve phone', () => resolvePhone(chatId, companyId));
  const phone = normalizeCanonicalClientPhone(
    phoneResult.ok ? phoneResult.value : '',
    chatId,
  );

  const findPending = deps.findPendingTransferBooking || findPendingTransferBooking;
  const booking = await findPending({ companyId, chatId, phone }, deps);
  if (!booking) {
    return { handled: true, confirmed: false, reply: NO_PENDING_REPLY, reasons: [] };
  }

  const parse = deps.parseReceipt || receiptReader.parseReceipt;
  const parsedResult = await runSafe('parse receipt', () =>
    parse(
      {
        buffer: media?.buffer,
        mimetype: media?.mimetype,
        filename: media?.filename,
      },
      deps,
    ),
  );
  const parsed = parsedResult.ok ? parsedResult.value : null;

  if (!parsed) {
    const reasons = ['no se pudo leer el comprobante'];
    await notifyInvalidReceipt(deps, { companyId, booking, phone, reasons });
    return { handled: true, confirmed: false, reply: buildInvalidReply(reasons), reasons };
  }

  const validate = deps.validateReceipt || receiptReader.validateReceipt;
  const { valid, reasons } = validate(parsed, {
    expectedAmount: booking?.deposit?.amount,
    bookingCreatedAt: booking?.createdAt,
  });

  if (!valid) {
    await notifyInvalidReceipt(deps, { companyId, booking, phone, reasons });
    return { handled: true, confirmed: false, reply: buildInvalidReply(reasons), reasons };
  }

  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const paymentId = `receipt:${booking._id}:${now}`;
  const approve = deps.approveDepositManually || depositService.approveDepositManually;
  const approval = await runSafe('approve deposit', () =>
    approve({ companyId, bookingId: booking._id, paymentId }),
  );

  // Concurrency guard: the atomic transition only applies while the booking is
  // still a pending transfer seña. A lost race means it was already processed.
  if (!approval.ok || !approval.value?.applied) {
    return { handled: true, confirmed: false, reply: NO_PENDING_REPLY, reasons: [] };
  }

  const notifyPaid = deps.handleDepositPaid || depositService.handleDepositPaid;
  await runSafe('deposit paid notification', () =>
    notifyPaid({ companyId, booking: approval.value.booking, paymentId }),
  );

  return { handled: true, confirmed: true, reply: CONFIRMED_REPLY, reasons: [] };
};

module.exports = {
  CONFIRMED_REPLY,
  INVALID_NOTIFICATION_TYPE,
  NO_PENDING_REPLY,
  buildInvalidReply,
  findPendingTransferBooking,
  handleIncomingReceipt,
};

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
const { getDepositSettings } = require('./appConfig.service');
const { isMongoConnected } = require('../config/database');

const NO_PENDING_REPLY = 'No tenés un turno pendiente de seña.';
const REVIEW_REPLY =
  '📥 Recibimos tu comprobante. El club lo va a revisar y te confirma en breve. ¡Gracias!';
const CONFIRMED_REPLY = '✅ *Seña verificada.* ¡Tu turno quedó confirmado! 🎾';
const INVALID_NOTIFICATION_TYPE = 'deposit_receipt_invalid';

const money = (value) => `$${Number(value || 0).toLocaleString("es-AR")}`;

// Mensaje claro para el cliente, explicando QUÉ falló y qué hacer.
const buildInvalidReply = (reasons = [], parsed = null, expectedAmount = null) => {
  const list = Array.isArray(reasons) ? reasons : [];
  const joined = list.join(" / ");

  if (/no se pudo leer/i.test(joined) || !list.length) {
    return (
      "❌ No pudimos leer el comprobante. 📸 Probá mandarlo más nítido (o en PDF) " +
      "y lo revisamos al toque."
    );
  }

  if (/monto/i.test(joined)) {
    const got = parsed?.amount ?? parsed?.amountPaid ?? null;
    return (
      `❌ El monto no coincide: la seña es de ${money(expectedAmount)}` +
      (got != null ? ` y el comprobante muestra ${money(got)}` : "") +
      ". Si ya transferiste ese importe, escribí al club y lo revisamos."
    );
  }

  if (/banco/i.test(joined)) {
    return (
      "❌ No reconocimos el banco del comprobante. Aceptamos Naranja X, MercadoPago, " +
      "Banco Nación, BBVA, Santander y Supervielle. Probá con el comprobante de esos."
    );
  }

  return `❌ No pudimos verificar el comprobante: ${joined}. Envialo de nuevo o escribí al club.`;
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

  // La ventana para acreditar la seña es la configurada por el club (holdMinutes);
  // 15 min si no está seteada.
  // Sin Mongo (tests, o base caída) se usa el default de 15 min y NO se cuelga.
  const settingsFn =
    deps.getDepositSettings ||
    (async (cid) => (isMongoConnected() ? getDepositSettings(cid) : null));
  const settings = await runSafe('load deposit settings', () => settingsFn(companyId));
  const holdMinutes = Number(settings?.ok ? settings.value?.holdMinutes : 0);
  const maxDeltaMinutes = holdMinutes > 0 ? holdMinutes : 15;

  const { valid, reasons } = validate(parsed, {
    expectedAmount: booking?.deposit?.amount,
    bookingCreatedAt: booking?.createdAt,
    maxDeltaMinutes,
  });

  if (!valid) {
    // "Fuera de la ventana de tiempo" con monto/banco correctos NO se rechaza:
    // la plata pudo llegar. Queda EN REVISIÓN para que el club confirme.
    const onlyTimeIssue =
      reasons.length > 0 &&
      reasons.some((r) => /fuera de los \d+ minutos/i.test(r)) &&
      !reasons.some((r) => /monto|banco|leer/i.test(r));

    await notifyInvalidReceipt(deps, { companyId, booking, phone, reasons });

    return {
      handled: true,
      confirmed: false,
      review: onlyTimeIssue,
      reply: onlyTimeIssue ? REVIEW_REPLY : buildInvalidReply(reasons, parsed, booking?.deposit?.amount),
      reasons,
    };
  }

  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const paymentId = `receipt:${booking._id}:${now}`;
  const approve = deps.approveDepositManually || depositService.approveDepositManually;
  const approval = await runSafe('approve deposit', () =>
    approve({ companyId, bookingId: booking._id, paymentId }),
  );

  // Error técnico al confirmar: NO decirle al cliente que no tiene turno. Se le
  // avisa que quedó en revisión y se alerta al club.
  if (!approval.ok) {
    await notifyInvalidReceipt(deps, {
      companyId,
      booking,
      phone,
      reasons: ['no se pudo confirmar automáticamente'],
    });
    return { handled: true, confirmed: false, review: true, reply: REVIEW_REPLY, reasons: [] };
  }

  // Guard de concurrencia: la transición atómica solo aplica si sigue pendiente
  // (una carrera perdida significa que ya se procesó).
  if (!approval.value?.applied) {
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

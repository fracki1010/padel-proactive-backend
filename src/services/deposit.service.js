'use strict';

// Booking deposit (seña) lifecycle.
//
// A booking with deposits enabled is created as `pendiente_seña` with a
// `deposit` subdocument. Approval (webhook) and expiry (sweeper) are ATOMIC and
// IDEMPOTENT: both are a single conditional `findOneAndUpdate` guarded on the
// booking still being `pendiente_seña` with `deposit.status = "pendiente"`, so a
// concurrent approve/expire pair lets exactly one transition win and a repeated
// call is a no-op. Approval deducts the seña with an update pipeline
// (`$subtract` clamped at 0) so finalPrice is never computed in JavaScript and
// cannot race.
//
// Persistence is injectable (`options.model`) so the lifecycle can be tested
// without a database.

const Booking = require('../models/booking.model');
const { createDepositPreference } = require('./mercadopago.service');

const BOOKING_STATUS = {
  PENDING_DEPOSIT: 'pendiente_seña',
  RESERVED: 'reservado',
  CANCELLED: 'cancelado',
};

const DEPOSIT_STATUS = {
  PENDING: 'pendiente',
  PAID: 'pagado',
  EXPIRED: 'expirado',
  // A paid deposit on a cancelled booking that still needs a manual refund.
  // `reembolsado` is reserved for the moment a refund is actually executed.
  REFUND_PENDING: 'refund_pending',
  REFUNDED: 'reembolsado',
};

const resolveModel = (options) => (options && options.model) || Booking;

const isValidIdentifier = (value) =>
  value !== undefined && value !== null && String(value).trim() !== '';

// Pure: builds the booking fields for a newly created pending-deposit booking.
const buildDepositFields = ({ settings, method = 'mercadopago', now = new Date() } = {}) => {
  const amount = Number(settings?.depositAmount) || 0;
  const holdMinutes = Number(settings?.holdMinutes) || 0;
  return {
    status: BOOKING_STATUS.PENDING_DEPOSIT,
    deposit: {
      required: true,
      amount,
      status: DEPOSIT_STATUS.PENDING,
      method:
        method === 'transfer' || method === 'mercadopago' ? method : 'mercadopago',
      preferenceId: null,
      paymentId: null,
      expiresAt: new Date(now.getTime() + holdMinutes * 60 * 1000),
      paidAt: null,
      refundable: false,
    },
  };
};

// Pure: a booking can only mint/refresh a live Checkout Pro link while it is a
// pending hold that has not passed its deadline. This stops a cancelled or
// already-expired booking from producing a payment link that could never be
// honoured.
const isBookingDepositPayable = (booking, now = new Date()) => {
  if (!booking) return false;
  if (booking.status !== BOOKING_STATUS.PENDING_DEPOSIT) return false;
  const expiresAt = booking.deposit?.expiresAt;
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) return false;
  return true;
};

// Reads the company-scoped booking (lean when the model is a real Mongoose
// query). Returns null when missing so callers can distinguish a late/unknown
// payment from an in-flight hold.
const getBookingForDeposit = async (
  { companyId, bookingId },
  options = {},
) => {
  const model = resolveModel(options);
  if (typeof model.findOne !== 'function') return null;
  const query = model.findOne({ _id: bookingId, companyId });
  const booking =
    query && typeof query.lean === 'function' ? await query.lean() : await query;
  return booking || null;
};

// Creates the MercadoPago preference for an already-persisted pending booking
// and stores its id. Best-effort by design: the booking is already pending, so a
// transient MP failure must not roll it back — the payment link can be
// regenerated from the payment-link endpoint.
const buildDepositPaymentLink = async (
  { companyId, booking, settings, backUrls, notificationUrl, now = new Date() },
  options = {},
) => {
  const amount = Number(settings?.depositAmount) || 0;
  if (!isBookingDepositPayable(booking, now)) {
    return {
      initPoint: '',
      preferenceId: '',
      amount,
      blocked: true,
      reason: 'booking_not_payable',
    };
  }

  const preference = await createDepositPreference(
    {
      companyId,
      booking,
      depositAmount: settings?.depositAmount,
      backUrls,
      notificationUrl,
      // Align the MP checkout expiration with the hold deadline so most late
      // payments are prevented at the source.
      expiresAt: booking?.deposit?.expiresAt || null,
    },
    options,
  );

  const model = resolveModel(options);
  if (booking?._id && preference?.preferenceId && typeof model.updateOne === 'function') {
    await model.updateOne(
      { _id: booking._id, companyId },
      { $set: { 'deposit.preferenceId': preference.preferenceId } },
    );
  }

  return {
    initPoint: preference?.initPoint || '',
    preferenceId: preference?.preferenceId || '',
    amount,
  };
};

// Atomic, idempotent approval: only a booking still pending its seña transitions
// to `reservado`. The finalPrice deduction runs in the database pipeline and is
// clamped at 0, so running twice or racing expiry leaves a consistent state.
const approveDeposit = async (
  { companyId, bookingId, paymentId, eventType = 'payment.approved' },
  options = {},
) => {
  if (!isValidIdentifier(companyId) || !isValidIdentifier(bookingId) || !isValidIdentifier(paymentId)) {
    return { applied: false, reason: 'invalid_input' };
  }

  const model = resolveModel(options);
  const updated = await model.findOneAndUpdate(
    {
      _id: bookingId,
      companyId,
      status: BOOKING_STATUS.PENDING_DEPOSIT,
      'deposit.status': DEPOSIT_STATUS.PENDING,
    },
    [
      {
        $set: {
          status: BOOKING_STATUS.RESERVED,
          'deposit.status': DEPOSIT_STATUS.PAID,
          'deposit.paymentId': String(paymentId),
          'deposit.paidAt': '$$NOW',
          finalPrice: {
            $max: [
              0,
              {
                $subtract: [
                  { $ifNull: ['$finalPrice', 0] },
                  { $ifNull: ['$deposit.amount', 0] },
                ],
              },
            ],
          },
        },
      },
    ],
    { returnDocument: 'after' },
  );

  if (!updated) {
    return { applied: false, reason: 'not_pending', eventType };
  }
  return { applied: true, booking: updated, paymentId: String(paymentId) };
};

// Manual (transfer) confirmation: the admin asserts the seña was received. It
// runs the SAME atomic transition as the webhook approval so both collection
// paths can never diverge. The synthetic paymentId is unique per
// (actor, booking) so the `deposit.paymentId` unique index never collides
// across manual confirmations by the same admin.
const approveDepositManually = async (
  { companyId, bookingId, actorId = null },
  options = {},
) => {
  if (!isValidIdentifier(companyId) || !isValidIdentifier(bookingId)) {
    return { applied: false, reason: 'invalid_input' };
  }
  const reference = `manual:${isValidIdentifier(actorId) ? actorId : 'admin'}:${bookingId}`;
  return approveDeposit(
    { companyId, bookingId, paymentId: reference, eventType: 'deposit.transfer.confirmed' },
    options,
  );
};

// Atomic expiry: only a still-pending booking whose deadline has passed is
// cancelled (which frees the court through the unique index). Idempotent.
// `companyId` is REQUIRED so an expiry can never cross tenants.
const expireDeposit = async (
  { bookingId, companyId, now = new Date() },
  options = {},
) => {
  if (!isValidIdentifier(bookingId) || !isValidIdentifier(companyId)) {
    return { expired: false, reason: 'invalid_input' };
  }

  const filter = {
    _id: bookingId,
    companyId,
    status: BOOKING_STATUS.PENDING_DEPOSIT,
    'deposit.status': DEPOSIT_STATUS.PENDING,
    'deposit.expiresAt': { $lt: now },
  };

  const model = resolveModel(options);
  const updated = await model.findOneAndUpdate(
    filter,
    {
      $set: {
        status: BOOKING_STATUS.CANCELLED,
        'deposit.status': DEPOSIT_STATUS.EXPIRED,
      },
    },
    { returnDocument: 'after' },
  );

  if (!updated) {
    return { expired: false, reason: 'not_expirable' };
  }
  return { expired: true, booking: updated };
};

// Pure: decides how a cancelled booking's deposit is recorded. A paid seña is
// flagged as pending refund (admin executes the actual refund — O1); an unpaid
// hold has nothing to refund and is voided as expired.
const markRefundableOnCancel = (booking) => {
  const deposit = booking?.deposit;
  if (!deposit) {
    return { refundable: false, deposit: null };
  }

  const plainDeposit =
    typeof deposit.toObject === 'function' ? deposit.toObject() : { ...deposit };

  if (plainDeposit.status === DEPOSIT_STATUS.PAID) {
    return {
      refundable: true,
      deposit: {
        ...plainDeposit,
        status: DEPOSIT_STATUS.REFUND_PENDING,
        refundable: true,
      },
    };
  }

  // Already awaiting/executed refund: keep the flag, don't downgrade the state.
  if (
    plainDeposit.status === DEPOSIT_STATUS.REFUND_PENDING ||
    plainDeposit.status === DEPOSIT_STATUS.REFUNDED
  ) {
    return { refundable: true, deposit: { ...plainDeposit, refundable: true } };
  }

  return {
    refundable: false,
    deposit: {
      ...plainDeposit,
      refundable: false,
      ...(plainDeposit.status === DEPOSIT_STATUS.PENDING
        ? { status: DEPOSIT_STATUS.EXPIRED }
        : {}),
    },
  };
};

// ── Post-approval side effects (best-effort, never throw) ────────────────────

const notifyPaidSafely = async ({ companyId, booking, paymentId }) => {
  const { notifyDepositPaid } = require('./depositNotification.service');
  return notifyDepositPaid({ companyId, booking, paymentId });
};

const notifyLateSafely = async ({ companyId, booking, bookingId, paymentId }) => {
  const { notifyDepositLatePayment } = require('./depositNotification.service');
  return notifyDepositLatePayment({ companyId, booking, bookingId, paymentId });
};

const notifyMismatchSafely = async (payload) => {
  const { notifyDepositAmountMismatch } = require('./depositNotification.service');
  return notifyDepositAmountMismatch(payload);
};

const runSafely = async (label, fn) => {
  try {
    const value = await fn();
    return { notified: true, value };
  } catch (error) {
    console.error(`[deposit] ${label} notification failed:`, error?.message || error);
    return { notified: false, error };
  }
};

const handleDepositPaid = async (
  { companyId = null, booking = null, paymentId = null },
  notify = null,
) =>
  runSafely('deposit_paid', () =>
    (notify || notifyPaidSafely)({ companyId, booking, paymentId }),
  );

// A payment approved after the hold was cancelled/expired: the money is
// captured but the court is gone, so this needs MANUAL review/refund. We never
// re-book the court and we never silently confirm.
const handleLatePayment = async (
  { companyId = null, booking = null, bookingId = null, paymentId = null },
  notify = null,
) =>
  runSafely('deposit_late_payment', () =>
    (notify || notifyLateSafely)({ companyId, booking, bookingId, paymentId }),
  );

// The captured amount does not match the configured seña: do not confirm, flag
// for manual review.
const handleAmountMismatch = async (
  { companyId = null, booking = null, bookingId = null, paymentId = null, expected = null, received = null },
  notify = null,
) =>
  runSafely('deposit_amount_mismatch', () =>
    (notify || notifyMismatchSafely)({
      companyId,
      booking,
      bookingId,
      paymentId,
      expected,
      received,
    }),
  );

module.exports = {
  BOOKING_STATUS,
  DEPOSIT_STATUS,
  approveDeposit,
  approveDepositManually,
  buildDepositFields,
  buildDepositPaymentLink,
  expireDeposit,
  getBookingForDeposit,
  handleAmountMismatch,
  handleDepositPaid,
  handleLatePayment,
  isBookingDepositPayable,
  markRefundableOnCancel,
};

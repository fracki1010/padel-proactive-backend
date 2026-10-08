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
  REFUNDED: 'reembolsado',
};

const resolveModel = (options) => (options && options.model) || Booking;

const isValidIdentifier = (value) =>
  value !== undefined && value !== null && String(value).trim() !== '';

// Pure: builds the booking fields for a newly created pending-deposit booking.
const buildDepositFields = ({ settings, now = new Date() } = {}) => {
  const amount = Number(settings?.depositAmount) || 0;
  const holdMinutes = Number(settings?.holdMinutes) || 0;
  return {
    status: BOOKING_STATUS.PENDING_DEPOSIT,
    deposit: {
      required: true,
      amount,
      status: DEPOSIT_STATUS.PENDING,
      preferenceId: null,
      paymentId: null,
      expiresAt: new Date(now.getTime() + holdMinutes * 60 * 1000),
      paidAt: null,
      refundable: false,
    },
  };
};

// Creates the MercadoPago preference for an already-persisted pending booking
// and stores its id. Best-effort by design: the booking is already pending, so a
// transient MP failure must not roll it back — the payment link can be
// regenerated from the payment-link endpoint.
const buildDepositPaymentLink = async (
  { companyId, booking, settings, backUrls, notificationUrl },
  options = {},
) => {
  const preference = await createDepositPreference(
    {
      companyId,
      booking,
      depositAmount: settings?.depositAmount,
      backUrls,
      notificationUrl,
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
    amount: Number(settings?.depositAmount) || 0,
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

// Atomic expiry: only a still-pending booking whose deadline has passed is
// cancelled (which frees the court through the unique index). Idempotent.
const expireDeposit = async (
  { bookingId, companyId = null, now = new Date() },
  options = {},
) => {
  if (!isValidIdentifier(bookingId)) {
    return { expired: false, reason: 'invalid_input' };
  }

  const filter = {
    _id: bookingId,
    status: BOOKING_STATUS.PENDING_DEPOSIT,
    'deposit.status': DEPOSIT_STATUS.PENDING,
    'deposit.expiresAt': { $lt: now },
  };
  if (isValidIdentifier(companyId)) filter.companyId = companyId;

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
// marked refundable (admin executes the actual refund — O1); an unpaid hold has
// nothing to refund and is voided as expired.
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
        status: DEPOSIT_STATUS.REFUNDED,
        refundable: true,
      },
    };
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

module.exports = {
  BOOKING_STATUS,
  DEPOSIT_STATUS,
  approveDeposit,
  buildDepositFields,
  buildDepositPaymentLink,
  expireDeposit,
  markRefundableOnCancel,
};

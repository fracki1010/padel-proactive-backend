'use strict';

// Lifecycle tests for the booking deposit (seña): pending-deposit creation
// fields, atomic + idempotent approval with finalPrice deduction, expiry only
// while still pending and past the deadline, the approve-vs-expire race, and
// the Slice-2 webhook seam integration (default seam -> deposit.service).
// Persistence is replaced with an in-memory Booking model.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-deposit-lifecycle';

const { createInMemoryBookingModel } = require('./helpers/inMemoryBookingModel');

// Patch the MP preference call BEFORE deposit.service is first required so its
// destructured reference captures the recorder.
const mpService = require('../services/mercadopago.service');
const mpPreference = { calls: [] };
mpService.createDepositPreference = async (args, options) => {
  mpPreference.calls.push({ args, options });
  return { initPoint: 'https://mp/checkout/pref-x', preferenceId: 'pref-x' };
};

// Neutralize the real notification side effects; deposit.service lazy-requires
// these modules and reads the properties at call time.
const notificationService = require('../services/notificationService');
const whatsappQueue = require('../services/whatsappCommandQueue.service');
notificationService.sendAdminNotification = async () => ({ queuedCount: 0 });
whatsappQueue.enqueueWhatsappCommand = async () => ({ command: { _id: 'cmd-x' } });

const COMPANY = '64b0000000000000000000a1';
const OTHER_COMPANY = '64b0000000000000000000b2';
const BOOKING_ID = '64b0000000000000000000c3';
const PAYMENT_ID = 'pay-777';

const pendingBooking = (overrides = {}) => ({
  _id: BOOKING_ID,
  companyId: COMPANY,
  status: 'pendiente_seña',
  finalPrice: 25000,
  deposit: {
    required: true,
    amount: 5000,
    status: 'pendiente',
    preferenceId: 'pref-1',
    paymentId: null,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    paidAt: null,
    refundable: false,
  },
  ...overrides,
});

// ── Model structure ──────────────────────────────────────────────────────────

test('booking model exposes pendiente_seña status, a deposit subdoc and deposit indexes', () => {
  const Booking = require('../models/booking.model');

  assert.ok(
    Booking.schema.path('status').enumValues.includes('pendiente_seña'),
    'status enum must include pendiente_seña',
  );
  assert.ok(Booking.schema.path('deposit.amount'), 'deposit.amount is missing');
  assert.ok(Booking.schema.path('deposit.expiresAt'), 'deposit.expiresAt is missing');

  const indexes = Booking.schema.indexes();
  const sweeper = indexes.find(
    ([definition]) =>
      definition.companyId === 1 &&
      definition['deposit.status'] === 1 &&
      definition['deposit.expiresAt'] === 1,
  );
  assert.ok(sweeper, 'missing (companyId, deposit.status, deposit.expiresAt) sweeper index');

  // NEW-2: the sweeper scans GLOBALLY (no companyId in the filter), so its
  // query needs an index led by status, not companyId.
  const globalSweep = indexes.find(
    ([definition]) =>
      definition.status === 1 &&
      definition['deposit.status'] === 1 &&
      definition['deposit.expiresAt'] === 1,
  );
  assert.ok(
    globalSweep,
    'missing global sweep index {status, deposit.status, deposit.expiresAt}',
  );

  const uniquePayment = indexes.find(
    ([definition, options]) =>
      definition['deposit.paymentId'] === 1 && options?.unique === true,
  );
  assert.ok(uniquePayment, 'missing unique deposit.paymentId index');
});

// ── buildDepositFields ───────────────────────────────────────────────────────

test('buildDepositFields marks the booking pending and sets amount + deadline', () => {
  const { buildDepositFields } = require('../services/deposit.service');
  const now = new Date('2026-10-08T12:00:00.000Z');

  const fields = buildDepositFields({
    settings: { depositEnabled: true, depositAmount: 5000, holdMinutes: 15 },
    now,
  });

  assert.equal(fields.status, 'pendiente_seña');
  assert.equal(fields.deposit.status, 'pendiente');
  assert.equal(fields.deposit.amount, 5000);
  assert.equal(fields.deposit.required, true);
  assert.equal(fields.deposit.paymentId, null);
  assert.equal(
    fields.deposit.expiresAt.getTime(),
    now.getTime() + 15 * 60 * 1000,
    'expiresAt must be now + holdMinutes',
  );

  // Triangulate: a different hold window and amount must flow through.
  const other = buildDepositFields({
    settings: { depositEnabled: true, depositAmount: 7000, holdMinutes: 30 },
    now,
  });
  assert.equal(other.deposit.amount, 7000);
  assert.equal(other.deposit.expiresAt.getTime(), now.getTime() + 30 * 60 * 1000);
});

// ── approveDeposit ───────────────────────────────────────────────────────────

test('approveDeposit deducts the seña and moves the booking to reservado/pagado', async () => {
  const { approveDeposit } = require('../services/deposit.service');
  const model = createInMemoryBookingModel([pendingBooking()]);

  const result = await approveDeposit(
    { companyId: COMPANY, bookingId: BOOKING_ID, paymentId: PAYMENT_ID },
    { model },
  );

  assert.equal(result.applied, true);
  const booking = model.bookings[0];
  assert.equal(booking.status, 'reservado');
  assert.equal(booking.deposit.status, 'pagado');
  assert.equal(booking.deposit.paymentId, PAYMENT_ID);
  assert.equal(booking.finalPrice, 20000);
  assert.ok(booking.deposit.paidAt instanceof Date, 'paidAt must be set');
});

test('approveDeposit is idempotent: a second call is a no-op', async () => {
  const { approveDeposit } = require('../services/deposit.service');
  const model = createInMemoryBookingModel([pendingBooking()]);

  const first = await approveDeposit(
    { companyId: COMPANY, bookingId: BOOKING_ID, paymentId: PAYMENT_ID },
    { model },
  );
  const second = await approveDeposit(
    { companyId: COMPANY, bookingId: BOOKING_ID, paymentId: PAYMENT_ID },
    { model },
  );

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'not_pending');
  assert.equal(
    model.bookings[0].finalPrice,
    20000,
    'the seña must be deducted exactly once',
  );
});

test('approveDeposit never touches a booking from another company', async () => {
  const { approveDeposit } = require('../services/deposit.service');
  const model = createInMemoryBookingModel([pendingBooking()]);

  const result = await approveDeposit(
    { companyId: OTHER_COMPANY, bookingId: BOOKING_ID, paymentId: PAYMENT_ID },
    { model },
  );

  assert.equal(result.applied, false);
  assert.equal(model.bookings[0].status, 'pendiente_seña');
  assert.equal(model.bookings[0].finalPrice, 25000);
});

test('approveDeposit clamps finalPrice at zero when the seña exceeds the price', async () => {
  const { approveDeposit } = require('../services/deposit.service');
  const model = createInMemoryBookingModel([
    pendingBooking({
      finalPrice: 3000,
      deposit: { ...pendingBooking().deposit, amount: 5000 },
    }),
  ]);

  const result = await approveDeposit(
    { companyId: COMPANY, bookingId: BOOKING_ID, paymentId: PAYMENT_ID },
    { model },
  );

  assert.equal(result.applied, true);
  assert.equal(model.bookings[0].finalPrice, 0);
});

// ── expireDeposit ────────────────────────────────────────────────────────────

test('expireDeposit cancels a past-deadline pending booking and releases the hold', async () => {
  const { expireDeposit } = require('../services/deposit.service');
  const model = createInMemoryBookingModel([
    pendingBooking({ deposit: { ...pendingBooking().deposit, expiresAt: new Date(Date.now() - 1000) } }),
  ]);

  const result = await expireDeposit({ bookingId: BOOKING_ID, companyId: COMPANY }, { model });

  assert.equal(result.expired, true);
  assert.equal(model.bookings[0].status, 'cancelado');
  assert.equal(model.bookings[0].deposit.status, 'expirado');
});

test('expireDeposit does nothing before the deadline or once paid', async () => {
  const { expireDeposit } = require('../services/deposit.service');
  const future = createInMemoryBookingModel([pendingBooking()]);
  const beforeDeadline = await expireDeposit(
    { bookingId: BOOKING_ID, companyId: COMPANY },
    { model: future },
  );
  assert.equal(beforeDeadline.expired, false);
  assert.equal(future.bookings[0].status, 'pendiente_seña');

  const paid = createInMemoryBookingModel([
    pendingBooking({
      status: 'reservado',
      deposit: { ...pendingBooking().deposit, status: 'pagado', expiresAt: new Date(Date.now() - 1000) },
    }),
  ]);
  const alreadyPaid = await expireDeposit(
    { bookingId: BOOKING_ID, companyId: COMPANY },
    { model: paid },
  );
  assert.equal(alreadyPaid.expired, false);
  assert.equal(paid.bookings[0].status, 'reservado');
});

// ── Race ─────────────────────────────────────────────────────────────────────

test('approve vs expire race: exactly one transition wins', async () => {
  const { approveDeposit, expireDeposit } = require('../services/deposit.service');
  const model = createInMemoryBookingModel([
    pendingBooking({ deposit: { ...pendingBooking().deposit, expiresAt: new Date(Date.now() - 1000) } }),
  ]);

  const [approved, expired] = await Promise.all([
    approveDeposit(
      { companyId: COMPANY, bookingId: BOOKING_ID, paymentId: PAYMENT_ID },
      { model },
    ),
    expireDeposit({ bookingId: BOOKING_ID, companyId: COMPANY }, { model }),
  ]);

  const outcomes = [approved.applied === true, expired.expired === true];
  assert.equal(
    outcomes.filter(Boolean).length,
    1,
    'exactly one of approve/expire must win the atomic race',
  );

  const booking = model.bookings[0];
  if (approved.applied) {
    assert.equal(booking.status, 'reservado');
    assert.equal(booking.deposit.status, 'pagado');
    assert.equal(booking.finalPrice, 20000);
  } else {
    assert.equal(booking.status, 'cancelado');
    assert.equal(booking.deposit.status, 'expirado');
    assert.equal(booking.finalPrice, 25000, 'a failed approve must not deduct');
  }
});

// ── markRefundableOnCancel ───────────────────────────────────────────────────

test('markRefundableOnCancel flags a paid deposit as refund_pending (not refunded)', () => {
  const { markRefundableOnCancel } = require('../services/deposit.service');

  const patch = markRefundableOnCancel({
    deposit: { status: 'pagado', amount: 5000, refundable: false },
  });

  assert.equal(patch.refundable, true);
  assert.equal(
    patch.deposit.status,
    'refund_pending',
    'a refund still has to be executed; do not claim reembolsado yet',
  );
  assert.equal(patch.deposit.refundable, true);

  // Triangulate: an unpaid pending deposit has nothing to refund.
  const pendingPatch = markRefundableOnCancel({
    deposit: { status: 'pendiente', amount: 5000, refundable: false },
  });
  assert.equal(pendingPatch.refundable, false);
  assert.notEqual(pendingPatch.deposit.status, 'refund_pending');

  // A booking without a deposit is untouched.
  assert.deepEqual(markRefundableOnCancel({}), { refundable: false, deposit: null });
});

// ── Payability guard + payment link ──────────────────────────────────────────

test('isBookingDepositPayable only allows a non-expired pending booking', () => {
  const { isBookingDepositPayable } = require('../services/deposit.service');
  const now = new Date('2026-10-08T12:00:00.000Z');
  const base = {
    status: 'pendiente_seña',
    deposit: { status: 'pendiente', expiresAt: new Date('2026-10-08T12:15:00.000Z') },
  };

  assert.equal(isBookingDepositPayable(base, now), true);
  assert.equal(
    isBookingDepositPayable(
      { ...base, deposit: { ...base.deposit, expiresAt: new Date('2026-10-08T11:59:00.000Z') } },
      now,
    ),
    false,
    'an expired hold must not be payable',
  );
  assert.equal(isBookingDepositPayable({ ...base, status: 'cancelado' }, now), false);
  assert.equal(isBookingDepositPayable({ ...base, status: 'reservado' }, now), false);
  assert.equal(isBookingDepositPayable(null, now), false);
});

test('buildDepositPaymentLink refuses to mint a live link for a dead booking', async () => {
  const { buildDepositPaymentLink, BOOKING_STATUS } = require('../services/deposit.service');
  mpPreference.calls.length = 0;
  const stubModel = { updateOne: async () => ({ matchedCount: 0 }) };

  const expired = await buildDepositPaymentLink(
    {
      companyId: COMPANY,
      booking: {
        _id: BOOKING_ID,
        status: BOOKING_STATUS.PENDING_DEPOSIT,
        deposit: { status: 'pendiente', expiresAt: new Date(Date.now() - 60 * 1000) },
      },
      settings: { depositAmount: 5000, holdMinutes: 15 },
    },
    { model: stubModel },
  );
  assert.equal(expired.initPoint, '');
  assert.equal(expired.blocked, true);
  assert.equal(mpPreference.calls.length, 0, 'must not call MercadoPago for an expired hold');

  const cancelled = await buildDepositPaymentLink(
    {
      companyId: COMPANY,
      booking: { _id: BOOKING_ID, status: BOOKING_STATUS.CANCELLED, deposit: null },
      settings: { depositAmount: 5000, holdMinutes: 15 },
    },
    { model: stubModel },
  );
  assert.equal(cancelled.blocked, true);
  assert.equal(mpPreference.calls.length, 0);

  // Triangulate: a live pending booking still mints a link and forwards the
  // hold deadline as the preference expiration.
  const live = await buildDepositPaymentLink(
    {
      companyId: COMPANY,
      booking: {
        _id: BOOKING_ID,
        status: BOOKING_STATUS.PENDING_DEPOSIT,
        deposit: { status: 'pendiente', expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
      },
      settings: { depositAmount: 5000, holdMinutes: 15 },
    },
    { model: stubModel },
  );
  assert.equal(live.initPoint, 'https://mp/checkout/pref-x');
  assert.equal(mpPreference.calls.length, 1);
  assert.ok(mpPreference.calls[0].args.expiresAt instanceof Date);
});

// ── getBookingForDeposit ─────────────────────────────────────────────────────

test('getBookingForDeposit returns the company-scoped booking or null', async () => {
  const { getBookingForDeposit } = require('../services/deposit.service');
  const model = createInMemoryBookingModel([pendingBooking()]);

  const found = await getBookingForDeposit(
    { companyId: COMPANY, bookingId: BOOKING_ID },
    { model },
  );
  assert.equal(String(found._id), BOOKING_ID);

  const crossCompany = await getBookingForDeposit(
    { companyId: OTHER_COMPANY, bookingId: BOOKING_ID },
    { model },
  );
  assert.equal(crossCompany, null);
});

// ── Slice-2 webhook seam integration ─────────────────────────────────────────

test('the default webhook seam resolves deposit.service.approveDeposit and applies the transition', async () => {
  const Booking = require('../models/booking.model');
  const model = createInMemoryBookingModel([pendingBooking()]);
  // Replace the persistence layer only; the real seam + real deposit.service run.
  Booking.findOneAndUpdate = (filter, update, options) =>
    model.findOneAndUpdate(filter, update, options);

  const { defaultApplyApprovedPayment } = require('../routes/webhook.routes');

  const result = await defaultApplyApprovedPayment({
    companyId: COMPANY,
    bookingId: BOOKING_ID,
    paymentId: PAYMENT_ID,
  });

  assert.equal(result.applied, true, 'the seam must report a confirmed transition');
  assert.equal(model.bookings[0].status, 'reservado');
  assert.equal(model.bookings[0].deposit.status, 'pagado');
  assert.equal(model.bookings[0].finalPrice, 20000);
});

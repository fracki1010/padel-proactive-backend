'use strict';

// Strict TDD suite for the WhatsApp receipt-verification handler.
//
// The handler decides what happens when a client sends a payment receipt:
// confirm the pending transfer seña, reply that nothing is pending, or reject
// with the failing reasons and alert an admin. All side effects are injected so
// the decision logic is exercised without a DB, queue, or network.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'gsk_test_dummy_key';

const {
  handleIncomingReceipt,
  findPendingTransferBooking,
  buildInvalidReply,
  CONFIRMED_REPLY,
  NO_PENDING_REPLY,
} = require('../services/receiptVerification.service');

const COMPANY = '64b0000000000000000000a1';
const BOOKING_ID = '64b0000000000000000000c3';
const CREATED_AT = new Date('2026-04-07T23:15:00.000Z'); // 20:15 ART

const pendingBooking = () => ({
  _id: BOOKING_ID,
  companyId: COMPANY,
  clientName: 'Ana',
  clientPhone: '5491100000000',
  status: 'pendiente_seña',
  createdAt: CREATED_AT,
  deposit: { required: true, amount: 5000, status: 'pendiente', method: 'transfer' },
});

const imageMedia = () => ({
  buffer: Buffer.from('fake-bytes'),
  mimetype: 'image/jpeg',
  filename: 'comprobante.jpg',
});

const buildDeps = (overrides = {}) => {
  const calls = { approved: [], paid: [], admin: [], parsed: 0 };
  const deps = {
    now: () => 1750000000000,
    getNumberByUser: async () => '5491100000000',
    findPendingTransferBooking: async () => pendingBooking(),
    parseReceipt: async () => {
      calls.parsed += 1;
      return { bank: 'Naranja X', amountPaid: 5000, date: '2026-04-07', time: '20:15' };
    },
    approveDepositManually: async (args) => {
      calls.approved.push(args);
      return { applied: true, booking: { ...pendingBooking(), status: 'reservado' }, paymentId: args.paymentId };
    },
    handleDepositPaid: async (args) => {
      calls.paid.push(args);
      return { notified: true };
    },
    sendAdminNotification: async (...args) => {
      calls.admin.push(args);
      return { queuedCount: 1 };
    },
    ...overrides,
  };
  return { deps, calls };
};

// ── Happy path ──────────────────────────────────────────────────────────────

test('a valid receipt auto-confirms the transfer seña and replies confirmation', async () => {
  const { deps, calls } = buildDeps();

  const result = await handleIncomingReceipt(
    { companyId: COMPANY, from: '5491100000000@c.us', media: imageMedia() },
    deps,
  );

  assert.equal(result.confirmed, true);
  assert.equal(result.reply, CONFIRMED_REPLY);
  assert.deepEqual(result.reasons, []);

  assert.equal(calls.approved.length, 1, 'the atomic transition must run exactly once');
  assert.equal(calls.approved[0].companyId, COMPANY);
  assert.equal(calls.approved[0].bookingId, BOOKING_ID);
  assert.equal(
    calls.approved[0].paymentId,
    `receipt:${BOOKING_ID}:1750000000000`,
    'the synthetic receipt payment id must identify the booking and moment',
  );

  assert.equal(calls.paid.length, 1, 'the full WhatsApp confirmation must be fired once');
  assert.equal(calls.admin.length, 0, 'a valid receipt must not alert the admin');
});

// ── Rejections ──────────────────────────────────────────────────────────────

test('an amount mismatch is rejected, notified and never confirmed', async () => {
  const { deps, calls } = buildDeps({
    parseReceipt: async () => ({
      bank: 'Naranja X',
      amountPaid: 4000,
      date: '2026-04-07',
      time: '20:15',
    }),
  });

  const result = await handleIncomingReceipt(
    { companyId: COMPANY, from: '5491100000000@c.us', media: imageMedia() },
    deps,
  );

  assert.equal(result.confirmed, false);
  assert.ok(result.reasons.includes('el monto no coincide'));
  assert.match(result.reply, /el monto no coincide/);
  assert.equal(calls.approved.length, 0, 'a rejected receipt must not confirm');
  assert.equal(calls.paid.length, 0);
  assert.equal(calls.admin.length, 1, 'the admin must be alerted');
  assert.equal(calls.admin[0][0], 'deposit_receipt_invalid');
});

test('a receipt outside the 15-minute window is rejected', async () => {
  const { deps, calls } = buildDeps({
    parseReceipt: async () => ({
      bank: 'Santander',
      amountPaid: 5000,
      date: '2026-04-07',
      time: '21:00',
    }),
  });

  const result = await handleIncomingReceipt(
    { companyId: COMPANY, from: '5491100000000@c.us', media: imageMedia() },
    deps,
  );

  assert.equal(result.confirmed, false);
  assert.ok(result.reasons.includes('la hora está fuera de los 15 minutos'));
  assert.equal(calls.approved.length, 0);
  assert.equal(calls.admin.length, 1);
});

test('an unreadable receipt is rejected with the read-failure reason', async () => {
  const { deps, calls } = buildDeps({ parseReceipt: async () => null });

  const result = await handleIncomingReceipt(
    { companyId: COMPANY, from: '5491100000000@c.us', media: imageMedia() },
    deps,
  );

  assert.equal(result.confirmed, false);
  assert.match(result.reply, /no se pudo leer el comprobante/);
  assert.equal(calls.approved.length, 0);
  assert.equal(calls.admin.length, 1);
});

// ── No pending booking ──────────────────────────────────────────────────────

test('with no pending transfer booking the handler replies and does not parse media', async () => {
  const { deps, calls } = buildDeps({ findPendingTransferBooking: async () => null });

  const result = await handleIncomingReceipt(
    { companyId: COMPANY, from: '5491100000000@c.us', media: imageMedia() },
    deps,
  );

  assert.equal(result.confirmed, false);
  assert.equal(result.reply, NO_PENDING_REPLY);
  assert.equal(calls.parsed, 0, 'media must not be read when there is nothing pending');
  assert.equal(calls.approved.length, 0);
});

// ── Reply builder ───────────────────────────────────────────────────────────

test('buildInvalidReply lists every failing reason', () => {
  const reply = buildInvalidReply(['el monto no coincide', 'el banco no está en la lista']);
  assert.match(reply, /el monto no coincide/);
  assert.match(reply, /el banco no está en la lista/);
});

// ── Query shape ─────────────────────────────────────────────────────────────

test('findPendingTransferBooking queries the latest pending transfer hold for the client', async () => {
  let capturedFilter = null;
  let sortArg = null;
  const fakeModel = {
    findOne(filter) {
      capturedFilter = filter;
      return {
        sort(arg) {
          sortArg = arg;
          return { lean: async () => ({ _id: BOOKING_ID }) };
        },
      };
    },
  };

  const booking = await findPendingTransferBooking(
    { companyId: COMPANY, chatId: '5491100000000@c.us', phone: '5491100000000' },
    { model: fakeModel },
  );

  assert.equal(booking._id, BOOKING_ID);
  assert.equal(capturedFilter.companyId, COMPANY);
  assert.equal(capturedFilter.status, 'pendiente_seña');
  assert.equal(capturedFilter['deposit.method'], 'transfer');
  assert.equal(capturedFilter['deposit.status'], 'pendiente');
  assert.deepEqual(sortArg, { createdAt: -1 }, 'must pick the most recent hold');
  assert.ok(Array.isArray(capturedFilter.$or), 'must match by phone OR whatsapp id');
});

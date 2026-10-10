'use strict';

// Deposit notification tests: the three notification types exist, the payment
// message is a pure builder carrying the link, and the pending/paid/expired
// notifiers hit the admin channel and enqueue the client WhatsApp message.
// The queue and notification service are injected as fakes.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Notification = require('../models/notification.model');

const COMPANY = '64b0000000000000000000a1';
const BOOKING_ID = '64b0000000000000000000c3';

const sampleBooking = (overrides = {}) => ({
  _id: BOOKING_ID,
  companyId: COMPANY,
  clientName: 'Ana Pérez',
  clientPhone: '5491100000000',
  date: new Date('2026-10-10T00:00:00.000Z'),
  court: { name: 'Cancha 1' },
  timeSlot: { startTime: '20:00', endTime: '21:00' },
  deposit: { amount: 5000, status: 'pendiente' },
  ...overrides,
});

const makeDeps = () => {
  const adminCalls = [];
  const enqueued = [];
  return {
    adminCalls,
    enqueued,
    deps: {
      sendAdminNotification: async (type, title, message, data, options) => {
        adminCalls.push({ type, title, message, data, options });
      },
      enqueueWhatsappCommand: async (command) => {
        enqueued.push(command);
        return { command: { _id: 'cmd-1' } };
      },
      // By default the resolver passes the booking through unchanged so tests
      // never touch the database; specific tests inject their own resolver.
      resolvePopulatedBooking: async (booking) => booking ?? null,
    },
  };
};

test('notification model accepts the deposit notification types', () => {
  const enumValues = Notification.schema.path('type').enumValues;
  for (const type of [
    'deposit_pending',
    'deposit_paid',
    'deposit_expired',
    'deposit_late_payment',
    'deposit_amount_mismatch',
  ]) {
    assert.ok(enumValues.includes(type), `missing notification type ${type}`);
  }
});

test('buildDepositPaymentMessage includes the amount and the payment link', () => {
  const { buildDepositPaymentMessage } = require('../services/bookingWhatsappConfirmation.service');

  const message = buildDepositPaymentMessage({
    client: { name: 'Ana Pérez' },
    court: { name: 'Cancha 1' },
    slot: { startTime: '20:00', endTime: '21:00' },
    date: new Date('2026-10-10T00:00:00.000Z'),
    deposit: { amount: 5000, initPoint: 'https://mp/checkout/pref-x' },
  });

  assert.match(message, /Ana Pérez/);
  assert.match(message, /Cancha 1/);
  assert.match(message, /5000/);
  assert.match(message, /https:\/\/mp\/checkout\/pref-x/);

  // Triangulate: without a link the message still carries the amount.
  const withoutLink = buildDepositPaymentMessage({
    client: { name: 'Ana' },
    court: { name: 'Cancha 2' },
    slot: { startTime: '10:00' },
    date: new Date('2026-10-11T00:00:00.000Z'),
    deposit: { amount: 7000 },
  });
  assert.match(withoutLink, /7000/);
  assert.doesNotMatch(withoutLink, /Pagá tu seña acá/);
});

test('notifyDepositPending alerts the admin and enqueues the client link', async () => {
  const { notifyDepositPending } = require('../services/depositNotification.service');
  const { deps, adminCalls, enqueued } = makeDeps();

  await notifyDepositPending(
    {
      booking: sampleBooking(),
      companyId: COMPANY,
      initPoint: 'https://mp/checkout/pref-x',
    },
    deps,
  );

  assert.equal(adminCalls.length, 1);
  assert.equal(adminCalls[0].type, 'deposit_pending');
  assert.equal(String(adminCalls[0].data.bookingId), BOOKING_ID);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].companyId, COMPANY);
  assert.match(enqueued[0].payload.message, /https:\/\/mp\/checkout\/pref-x/);
  assert.equal(enqueued[0].payload.to, '5491100000000@c.us');
});

test('notifyDepositPending with notifyClient=false alerts the admin only (bot path)', async () => {
  const { notifyDepositPending } = require('../services/depositNotification.service');
  const { deps, adminCalls, enqueued } = makeDeps();

  await notifyDepositPending(
    {
      booking: sampleBooking(),
      companyId: COMPANY,
      initPoint: 'https://mp/checkout/pref-x',
      notifyClient: false,
    },
    deps,
  );

  assert.equal(adminCalls.length, 1);
  assert.equal(adminCalls[0].type, 'deposit_pending');
  assert.equal(
    enqueued.length,
    0,
    'the bot chat reply already carries the link, so no duplicate client message',
  );
});

test('notifyDepositPaid and notifyDepositExpired use their notification types', async () => {
  const {
    notifyDepositPaid,
    notifyDepositExpired,
  } = require('../services/depositNotification.service');

  const paid = makeDeps();
  await notifyDepositPaid({ booking: sampleBooking(), companyId: COMPANY }, paid.deps);
  assert.equal(paid.adminCalls[0].type, 'deposit_paid');

  const expired = makeDeps();
  await notifyDepositExpired({ booking: sampleBooking(), companyId: COMPANY }, expired.deps);
  assert.equal(expired.adminCalls[0].type, 'deposit_expired');
});

test('a client without a phone still notifies the admin but skips WhatsApp', async () => {
  const { notifyDepositPaid } = require('../services/depositNotification.service');
  const { deps, adminCalls, enqueued } = makeDeps();

  await notifyDepositPaid(
    { booking: sampleBooking({ clientPhone: null }), companyId: COMPANY },
    deps,
  );

  assert.equal(adminCalls.length, 1);
  assert.equal(enqueued.length, 0);
});

// ── Paid confirmation: the client gets the FULL turn details ────────────────

test('notifyDepositPaid enqueues the FULL confirmation (cancha, fecha, hora) when court/timeSlot are resolved', async () => {
  const { notifyDepositPaid } = require('../services/depositNotification.service');
  const { deps, enqueued } = makeDeps();

  const booking = sampleBooking({
    court: { name: 'Cancha 1' },
    timeSlot: { startTime: '20:00', endTime: '21:00', price: 8000 },
  });

  await notifyDepositPaid({ booking, companyId: COMPANY }, deps);

  assert.equal(enqueued.length, 1);
  const message = enqueued[0].payload.message;
  assert.match(message, /Cancha 1/);
  assert.match(message, /20:00 a 21:00/);
  assert.match(message, /sábado 10 de octubre/, 'fecha must render the booking date');
  assert.match(message, /\$8000/, 'the price must be part of the full confirmation');
  assert.doesNotMatch(message, /Seña acreditada/, 'the generic one-liner must be replaced');
  assert.equal(enqueued[0].payload.to, '5491100000000@c.us');
});

test('notifyDepositPaid falls back to the generic message when the resolver fails', async () => {
  const { notifyDepositPaid } = require('../services/depositNotification.service');
  const { adminCalls, enqueued, deps } = makeDeps();
  const throwingDeps = {
    ...deps,
    resolvePopulatedBooking: async () => {
      throw new Error('db down');
    },
  };

  // The webhook passes the RAW booking (ObjectIds) — the resolver is the only
  // source of populated fields, so a failure must degrade to the fallback.
  const rawBooking = sampleBooking({
    court: '64b0000000000000000000c4',
    timeSlot: '64b0000000000000000000c5',
  });

  const result = await notifyDepositPaid(
    { booking: rawBooking, companyId: COMPANY },
    throwingDeps,
  );

  assert.equal(result.notified, true, 'a resolver failure must never reject the notifier');
  assert.equal(adminCalls.length, 1);
  assert.equal(enqueued.length, 1, 'the client must still receive a confirmation');
  assert.match(enqueued[0].payload.message, /Seña acreditada/);
});

test('notifyDepositPaid keeps rendering the full confirmation when the original booking already carries resolved fields (portal path)', async () => {
  const { notifyDepositPaid } = require('../services/depositNotification.service');
  const { adminCalls, enqueued, deps } = makeDeps();
  const throwingDeps = {
    ...deps,
    resolvePopulatedBooking: async () => {
      throw new Error('db down');
    },
  };

  await notifyDepositPaid({ booking: sampleBooking(), companyId: COMPANY }, throwingDeps);

  assert.equal(adminCalls.length, 1);
  assert.equal(enqueued.length, 1);
  assert.match(enqueued[0].payload.message, /Cancha 1/);
  assert.doesNotMatch(enqueued[0].payload.message, /Seña acreditada/);
});

test('notifyDepositPaid falls back to the generic message when court/timeSlot stay unresolved', async () => {
  const { notifyDepositPaid } = require('../services/depositNotification.service');
  const { deps, enqueued } = makeDeps();

  // Raw ObjectIds: no name/startTime to render, even after resolve.
  const rawBooking = sampleBooking({
    court: '64b0000000000000000000c4',
    timeSlot: '64b0000000000000000000c5',
  });

  await notifyDepositPaid({ booking: rawBooking, companyId: COMPANY }, deps);

  assert.equal(enqueued.length, 1, 'an unresolved booking still gets a confirmation');
  assert.match(enqueued[0].payload.message, /Seña acreditada/);
});

// ── WARNING 7: side effects independent ──────────────────────────────────────

test('notifyDepositPending still enqueues the client link when the admin alert fails', async () => {
  const { notifyDepositPending } = require('../services/depositNotification.service');
  const enqueued = [];
  const deps = {
    sendAdminNotification: async () => {
      throw new Error('admin channel down');
    },
    enqueueWhatsappCommand: async (command) => {
      enqueued.push(command);
      return { command: { _id: 'cmd-1' } };
    },
  };

  const result = await notifyDepositPending(
    { booking: sampleBooking(), companyId: COMPANY, initPoint: 'https://mp/checkout/pref-x' },
    deps,
  );

  assert.equal(enqueued.length, 1, 'the client payment link must not be suppressed');
  assert.match(enqueued[0].payload.message, /https:\/\/mp\/checkout\/pref-x/);
  assert.equal(result.adminNotified, false);
});

// ── Late / mismatch review notifications ─────────────────────────────────────

test('notifyDepositLatePayment alerts admins (no client message) for a late payment', async () => {
  const { notifyDepositLatePayment } = require('../services/depositNotification.service');
  const { deps, adminCalls, enqueued } = makeDeps();

  await notifyDepositLatePayment(
    { booking: sampleBooking(), companyId: COMPANY, paymentId: 'pay-999' },
    deps,
  );

  assert.equal(adminCalls.length, 1);
  assert.equal(adminCalls[0].type, 'deposit_late_payment');
  assert.match(adminCalls[0].message, /pay-999/);
  assert.equal(enqueued.length, 0, 'a late payment needs review, not a client confirmation');
});

test('notifyDepositAmountMismatch alerts admins with expected vs received', async () => {
  const { notifyDepositAmountMismatch } = require('../services/depositNotification.service');
  const { deps, adminCalls } = makeDeps();

  await notifyDepositAmountMismatch(
    {
      booking: sampleBooking(),
      companyId: COMPANY,
      paymentId: 'pay-999',
      expected: 5000,
      received: 4500,
    },
    deps,
  );

  assert.equal(adminCalls.length, 1);
  assert.equal(adminCalls[0].type, 'deposit_amount_mismatch');
  assert.match(adminCalls[0].message, /5000/);
  assert.match(adminCalls[0].message, /4500/);
});

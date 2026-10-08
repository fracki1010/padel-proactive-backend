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
    },
  };
};

test('notification model accepts the deposit notification types', () => {
  const enumValues = Notification.schema.path('type').enumValues;
  for (const type of ['deposit_pending', 'deposit_paid', 'deposit_expired']) {
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

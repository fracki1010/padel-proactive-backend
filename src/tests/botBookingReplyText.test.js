'use strict';

// Bot booking reply copy: when the bot booking is a pending deposit the reply
// must append the seña amount and the Checkout Pro payment link to the existing
// confirmation message. Without a deposit the legacy reply is unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildBookingReplyText } = require('../handlers/messageHandler');
const { getFormattedDate } = require('../utils/getFormattedDate');

const DATE = '2099-01-01';

const successResult = (data = {}) => ({
  success: true,
  data: {
    courtName: 'Cancha 1',
    courtType: 'Techada',
    startTime: '20:00',
    endTime: '21:00',
    price: 25000,
    ...data,
  },
});

test('reply without a deposit keeps the legacy confirmed message', () => {
  const reply = buildBookingReplyText(DATE, 'Ana', successResult());

  const expected =
    `✅ *¡Reserva Confirmada!* 🎾\n\n` +
    `👤 *Jugador:* Ana\n` +
    `📌 *Cancha:* Cancha 1 (Techada)\n` +
    `📅 *Fecha:* ${getFormattedDate(DATE)}\n` +
    `⏰ *Hora:* 20:00 - 21:00\n` +
    `💰 *Precio:* $25000`;

  assert.equal(reply, expected);
});

test('reply with a pending deposit uses the pending header and appends the link', () => {
  const reply = buildBookingReplyText(
    DATE,
    'Ana',
    successResult({
      deposit: {
        amount: 5000,
        initPoint: 'https://mp/checkout/pref-x',
        expiresAt: new Date(),
      },
    }),
  );

  assert.match(reply, /¡Ya casi es tuyo!/);
  assert.match(reply, /Falta la seña/i);
  assert.doesNotMatch(reply, /Reserva Confirmada/);
  assert.match(reply, /Seña:\* \$5000/);
  assert.match(reply, /https:\/\/mp\/checkout\/pref-x/);
});

test('reply with a deposit but no link still states the seña amount', () => {
  const reply = buildBookingReplyText(
    DATE,
    'Ana',
    successResult({
      deposit: { amount: 5000, initPoint: '', expiresAt: new Date() },
    }),
  );

  assert.match(reply, /¡Ya casi es tuyo!/);
  assert.doesNotMatch(reply, /Reserva Confirmada/);
  assert.match(reply, /Seña:\* \$5000/);
  assert.doesNotMatch(reply, /Pagá tu seña/);
  assert.doesNotMatch(reply, /https:\/\//);
});

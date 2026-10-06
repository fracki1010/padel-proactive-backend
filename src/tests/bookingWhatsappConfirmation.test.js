'use strict';

// Contract for the portal booking confirmation: after a client books from the
// web portal, the backend must enqueue a WhatsApp `send_message` command to the
// client's verified phone, containing court, date, time and price.
//
// The enqueue step is best-effort: a failing queue MUST NOT break the booking
// (the controller still answers 201). These tests pin both behaviours through
// the extracted service, which the controller wires in.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-booking-wa';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBookingWhatsappConfirmation,
  sendBookingWhatsappConfirmation,
} = require('../services/bookingWhatsappConfirmation.service');
const { COMMAND_TYPES } = require('../services/whatsappCommandQueue.service');

const BOOKING = {
  clientPhone: '5491122334455',
  companyId: 'company-a',
  client: { name: 'Ana Pérez' },
  court: { name: 'Cancha 1' },
  slot: { startTime: '14:00', endTime: '15:30', price: 8000 },
  date: '2026-10-06',
};

// ── Message builder (pure) ───────────────────────────────────────────────────

test('buildBookingWhatsappConfirmation builds the exact portal confirmation message', () => {
  const message = buildBookingWhatsappConfirmation(BOOKING);

  assert.equal(
    message,
    `✅ *¡Tu turno está confirmado!* 🎾\n\n` +
      `👤 *Ana Pérez*\n` +
      `📌 *Cancha:* Cancha 1\n` +
      `📅 *Fecha:* martes 6 de octubre\n` +
      `⏰ *Hora:* 14:00 a 15:30\n` +
      `💰 *Total:* $8000\n\n` +
      `¡Te esperamos en el club! 🏸`,
  );
});

test('buildBookingWhatsappConfirmation renders other court, date and price (triangulation)', () => {
  const message = buildBookingWhatsappConfirmation({
    client: { name: 'Juan Gómez' },
    court: { name: 'Cancha 3' },
    slot: { startTime: '20:00', endTime: '21:30', price: 12500 },
    date: '2026-12-25',
  });

  assert.match(message, /👤 \*Juan Gómez\*/);
  assert.match(message, /📌 \*Cancha:\* Cancha 3/);
  assert.match(message, /📅 \*Fecha:\* viernes 25 de diciembre/);
  assert.match(message, /⏰ \*Hora:\* 20:00 a 21:30/);
  assert.match(message, /💰 \*Total:\* \$12500/);
});

test('buildBookingWhatsappConfirmation falls back to $0 when the slot has no price', () => {
  const message = buildBookingWhatsappConfirmation({
    client: { name: 'Sin Precio' },
    court: { name: 'Cancha 5' },
    slot: { startTime: '09:00', endTime: '10:30' },
    date: '2026-10-06',
  });

  assert.match(message, /💰 \*Total:\* \$0/);
});

// ── Enqueue wiring (best-effort) ─────────────────────────────────────────────

test('sendBookingWhatsappConfirmation enqueues send_message to the client phone', async () => {
  const calls = [];
  const fakeEnqueue = async (args) => {
    calls.push(args);
    return { command: { _id: 'cmd-1' } };
  };

  const result = await sendBookingWhatsappConfirmation({ ...BOOKING, enqueue: fakeEnqueue });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);

  const [enqueued] = calls;
  assert.equal(enqueued.type, COMMAND_TYPES.SEND_MESSAGE);
  assert.equal(enqueued.companyId, 'company-a');
  assert.equal(enqueued.payload.to, '5491122334455');
  assert.match(enqueued.payload.message, /Cancha 1/);
  assert.match(enqueued.payload.message, /14:00 a 15:30/);
  assert.match(enqueued.payload.message, /\$8000/);
});

test('sendBookingWhatsappConfirmation resolves with ok:false when enqueue fails', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const fakeEnqueue = async () => {
      throw new Error('redis down');
    };

    // Must resolve (never reject) so the controller can still answer 201.
    const result = await sendBookingWhatsappConfirmation({ ...BOOKING, enqueue: fakeEnqueue });

    assert.equal(result.ok, false);
    assert.equal(result.error.message, 'redis down');
  } finally {
    console.error = originalConsoleError;
  }
});

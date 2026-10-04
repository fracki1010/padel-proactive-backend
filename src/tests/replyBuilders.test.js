'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildAntiLoopReply,
  buildBookingReplyText,
  buildSecondBookingConfirmationText,
  buildActiveBookingsReply,
} = require('../whatsapp/domain/replyBuilders');

test('buildAntiLoopReply guides the user per intent and missing state', () => {
  assert.strictEqual(
    buildAntiLoopReply({ interpretation: { detectedIntent: 'CREATE_BOOKING' } }),
    'Entendido. Para reservar sin errores necesito *fecha y hora* (ej: hoy 20:00).',
  );
  assert.strictEqual(
    buildAntiLoopReply({ sessionMeta: { awaitingFullNameForBooking: true } }),
    'Sigo esperando tu *nombre y apellido* para avanzar con la reserva. Ejemplo: *Juan Pérez*.',
  );
  assert.strictEqual(
    buildAntiLoopReply({}),
    'Te estoy entendiendo, pero para avanzar necesito un dato más concreto.',
  );
});

test('buildBookingReplyText formats a successful booking and busy error', () => {
  const ok = buildBookingReplyText('2026-04-07', 'Juan', {
    success: true,
    data: { courtName: 'Cancha 1', startTime: '20:00', endTime: '21:00', price: 15000 },
  });
  assert.match(ok, /¡Reserva Confirmada!/);
  assert.match(ok, /Jugador:\* Juan/);
  assert.match(ok, /Cancha:\* Cancha 1/);
  assert.match(ok, /Hora:\* 20:00 - 21:00/);
  assert.match(ok, /Precio:\* \$15000/);
  assert.strictEqual(
    buildBookingReplyText('2026-04-07', 'Juan', { success: false, error: 'BUSY' }),
    '🚫 Ese turno ya está ocupado. ¿Te busco otro?',
  );
});

test('buildSecondBookingConfirmationText is the fixed extra-confirmation prompt', () => {
  assert.strictEqual(
    buildSecondBookingConfirmationText(),
    'Ya tenés una reserva activa. Para continuar sin errores, respondé *CONFIRMAR EXTRA* o *CANCELAR*.',
  );
});

test('buildActiveBookingsReply renders empty and populated lists', () => {
  assert.strictEqual(
    buildActiveBookingsReply([]),
    '📭 No encontré reservas vigentes para este número de WhatsApp.',
  );
  const one = buildActiveBookingsReply([
    { courtName: 'Cancha 1', startTime: '20:00', endTime: '21:00', date: '2026-04-07' },
  ]);
  assert.match(one, /Estas son tus reservas vigentes/);
  assert.match(one, /20:00 - 21:00/);
  assert.match(one, /Cancha 1/);
});
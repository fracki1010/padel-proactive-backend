'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  inferFallbackAction,
  inferDeterministicAction,
  isAffirmativeBookingReply,
  isNegativeBookingReply,
  hasDirectBookingIntent,
  hasBookingControlKeywords,
} = require('../whatsapp/domain/intentDetection');

test('inferFallbackAction detects the active-bookings intent', () => {
  assert.deepStrictEqual(inferFallbackAction('tengo reservas'), {
    action: 'LIST_ACTIVE_BOOKINGS',
  });
});

test('inferFallbackAction returns null for unknown input', () => {
  assert.strictEqual(inferFallbackAction('hola'), null);
});

test('inferDeterministicAction falls back to deterministic fallback detection', () => {
  assert.strictEqual(inferDeterministicAction('mis turnos')?.action, 'LIST_ACTIVE_BOOKINGS');
  assert.strictEqual(inferDeterministicAction('hola'), null);
});

test('affirmative and negative booking replies are recognized', () => {
  assert.strictEqual(isAffirmativeBookingReply('si'), true);
  assert.strictEqual(isAffirmativeBookingReply('ok'), true);
  assert.strictEqual(isAffirmativeBookingReply('quizas'), false);
  assert.strictEqual(isNegativeBookingReply('no'), true);
  assert.strictEqual(isNegativeBookingReply('cancelar'), true);
  assert.strictEqual(isNegativeBookingReply('tal vez'), false);
});

test('direct booking intent excludes past-booking references', () => {
  assert.strictEqual(hasDirectBookingIntent('quiero reservar'), true);
  assert.strictEqual(hasDirectBookingIntent('ya me hizo la reserva'), false);
  assert.strictEqual(hasDirectBookingIntent('hola'), false);
});

test('booking control keywords are detected in operational phrases', () => {
  assert.strictEqual(hasBookingControlKeywords('confirmar turno'), true);
  assert.strictEqual(hasBookingControlKeywords('hola'), false);
});
'use strict';

// Regresión de la guarda de salida P0 en la ruta interna del worker: ningún reply
// que parezca payload JSON crudo debe encolarse hacia WhatsApp.

const { test } = require('node:test');
const assert = require('node:assert');

process.env.GROQ_API_KEY = 'gsk_test_dummy_key_for_unit_tests';

const { extractReplyMessage } = require('../routes/internal.routes');
const {
  sanitizeOutgoingReply,
  SAFE_FALLBACK_REPLY,
} = require('../utils/conversationGuardrails');

test('extractReplyMessage rescata .message de JSON válido', () => {
  assert.equal(extractReplyMessage('{"action":"CHAT","message":"hola"}'), 'hola');
  assert.equal(extractReplyMessage({ message: 'hola' }), 'hola');
  assert.equal(extractReplyMessage('{"action":"CHAT","message":"hola"}   '), 'hola');
});

test('extractReplyMessage deja pasar texto plano y JSON sin .message', () => {
  assert.equal(extractReplyMessage('hola que tal'), 'hola que tal');
  assert.equal(
    extractReplyMessage('{"action":"CREATE_BOOKING","courtName":"Techada"}'),
    '{"action":"CREATE_BOOKING","courtName":"Techada"}',
  );
  assert.equal(extractReplyMessage(''), '');
  assert.equal(extractReplyMessage(null), '');
});

test('guarda anti-JSON: payload JSON crudo se reemplaza con nudge seguro', () => {
  const truncated =
    '{"action":"CREATE_BOOKING","courtName":"Techada","clientName":"Ju';
  assert.equal(
    sanitizeOutgoingReply(extractReplyMessage(truncated)),
    SAFE_FALLBACK_REPLY,
  );
  assert.equal(
    sanitizeOutgoingReply(extractReplyMessage('  {"truncado":')),
    SAFE_FALLBACK_REPLY,
  );
  assert.equal(
    sanitizeOutgoingReply(extractReplyMessage('hola que tal')),
    'hola que tal',
  );
});
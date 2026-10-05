'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  extractJSON,
  looksLikeJsonPayload,
  startsWithJsonObject,
  UNPARSEABLE_SENTINEL,
} = require('../whatsapp/domain/extractModelJson');

test('extractJSON parsea JSON directo válido', () => {
  assert.deepEqual(extractJSON('{"action":"CREATE_BOOKING","time":"17:00"}'), {
    action: 'CREATE_BOOKING',
    time: '17:00',
  });
  assert.deepEqual(extractJSON('[1,2,3]'), [1, 2, 3]);
});

test('extractJSON quita fences de markdown y parsea', () => {
  const fenced = '```json\n{"action":"CHECK_AVAILABILITY","date":"2026-10-06"}\n```';
  assert.deepEqual(extractJSON(fenced), {
    action: 'CHECK_AVAILABILITY',
    date: '2026-10-06',
  });
  const plainFence = '```\n{"message":"hola"}\n```';
  assert.deepEqual(extractJSON(plainFence), { message: 'hola' });
});

test('extractJSON extrae JSON balanceado dentro de texto libre', () => {
  const withPreface =
    'Acá va la respuesta: {"action":"LIST_ACTIVE_BOOKINGS"} fin del mensaje.';
  assert.deepEqual(extractJSON(withPreface), { action: 'LIST_ACTIVE_BOOKINGS' });
});

test('extractJSON respeta llaves dentro de strings al balancear', () => {
  const tricky = '{"message":"el horario {no} existe","action":"CHAT"}';
  assert.deepEqual(extractJSON(tricky), {
    message: 'el horario {no} existe',
    action: 'CHAT',
  });
});

test('extractJSON devuelve centinela ante JSON truncado que empieza con {', () => {
  const truncated = '{"action":"CREATE_BOOKING","clientName":"Ju';
  assert.deepEqual(extractJSON(truncated), UNPARSEABLE_SENTINEL);
  assert.equal(extractJSON(truncated).__unparseable, true);
});

test('extractJSON devuelve centinela ante JSON malformado que empieza con {', () => {
  const malformed = '{"action": "CREATE_BOOKING", "time": "17:00",}';
  assert.equal(extractJSON(malformed).__unparseable, true);
});

test('extractJSON devuelve centinela ante array truncado', () => {
  const truncatedArray = '[{"a":1';
  assert.equal(extractJSON(truncatedArray).__unparseable, true);
});

test('extractJSON devuelve null para texto plano', () => {
  assert.equal(extractJSON('hola, ¿en qué te ayudo?'), null);
  assert.equal(extractJSON('Tengo 2 canchas libres a las 17:00'), null);
});

test('extractJSON devuelve null para vacío y no-string', () => {
  assert.equal(extractJSON(''), null);
  assert.equal(extractJSON('   \n\t '), null);
  assert.equal(extractJSON(null), null);
  assert.equal(extractJSON(undefined), null);
  assert.equal(extractJSON(42), null);
});

test('looksLikeJsonPayload detecta JSON crudo y no texto legítimo', () => {
  assert.equal(looksLikeJsonPayload('{"action":"CREATE_BOOKING"}'), true);
  assert.equal(looksLikeJsonPayload('["a","b"]'), true);
  assert.equal(looksLikeJsonPayload('{"message":"hola"}'), true);
  assert.equal(
    looksLikeJsonPayload('prefacio {"action":"CHAT"}'),
    true,
    'contiene clave "action"',
  );
  assert.equal(looksLikeJsonPayload('hola que tal'), false);
  assert.equal(
    looksLikeJsonPayload('Tengo {2} canchas libres a las 17:00'),
    false,
    'llaves en medio de texto no son payload JSON',
  );
});

test('startsWithJsonObject detecta inicio de objeto/array JSON', () => {
  assert.equal(startsWithJsonObject('{"action":"x"}'), true);
  assert.equal(startsWithJsonObject('   ["a"]'), true);
  assert.equal(startsWithJsonObject('  {"message":"hola"}'), true);
  assert.equal(startsWithJsonObject('hola {"action":"x"}'), false);
  assert.equal(startsWithJsonObject(''), false);
});
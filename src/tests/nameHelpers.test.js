'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  isLikelyFullName,
  isPlaceholderName,
  isNonNameReply,
  extractFullNameFromMessage,
  isValidClientName,
} = require('../whatsapp/domain/extractPersonName');

test('isLikelyFullName requires at least two name tokens', () => {
  assert.strictEqual(isLikelyFullName('Juan Perez'), true);
  assert.strictEqual(isLikelyFullName('Juan'), false);
});

test('isPlaceholderName detects placeholder values', () => {
  assert.strictEqual(isPlaceholderName('cliente'), true);
  assert.strictEqual(isPlaceholderName('Juan Perez'), false);
});

test('isNonNameReply rejects operational phrases but accepts real names', () => {
  assert.strictEqual(isNonNameReply('si'), true);
  assert.strictEqual(isNonNameReply(''), true);
  assert.strictEqual(isNonNameReply('Juan Perez'), false);
});

test('extractFullNameFromMessage extracts a name from a natural sentence', () => {
  assert.strictEqual(extractFullNameFromMessage('mi nombre es Juan Perez'), 'Juan Perez');
  assert.strictEqual(extractFullNameFromMessage('hola'), null);
});

test('isValidClientName accepts real names and rejects placeholders', () => {
  assert.strictEqual(isValidClientName('Juan Perez'), true);
  assert.strictEqual(isValidClientName('Cliente'), false);
});
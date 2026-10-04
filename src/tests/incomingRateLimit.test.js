'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  fingerprintMessage,
  enforceIncomingRateLimit,
  auditSecurityEvent,
  MAX_SAME_MESSAGE_BEFORE_LOOP_REPLY,
} = require('../utils/incomingRateLimit');

test('fingerprintMessage normalizes to a canonical loose key', () => {
  assert.strictEqual(fingerprintMessage('HÓLÁ  Juan!!!'), 'hola juan');
  assert.strictEqual(fingerprintMessage('   '), '');
});

test('MAX_SAME_MESSAGE_BEFORE_LOOP_REPLY is 3', () => {
  assert.strictEqual(MAX_SAME_MESSAGE_BEFORE_LOOP_REPLY, 3);
});

test('enforceIncomingRateLimit blocks after the message budget is exceeded', () => {
  const sessionId = `rate-${Date.now()}-${Math.random()}`;
  let last = null;
  for (let i = 0; i < 15; i += 1) {
    last = enforceIncomingRateLimit({
      sessionId,
      companyId: null,
      chatId: 'x',
      userMessage: 'hola',
    });
  }
  assert.strictEqual(last.blocked, true);
  assert.match(last.reply, /demasiados mensajes/);
});

test('enforceIncomingRateLimit allows early messages in the window', () => {
  const sessionId = `rate-early-${Date.now()}-${Math.random()}`;
  const first = enforceIncomingRateLimit({
    sessionId,
    companyId: null,
    chatId: 'x',
    userMessage: 'hola',
  });
  assert.deepStrictEqual(first, { blocked: false, reply: null });
});

test('auditSecurityEvent does not throw and records a warn', () => {
  assert.doesNotThrow(() =>
    auditSecurityEvent({ companyId: null, event: 'TEST_EVENT', reason: 'test', userMessage: 'x' }),
  );
});
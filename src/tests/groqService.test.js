'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// groqService exige una GROQ_API_KEY al cargar (process.exit si no hay). Este test
// corre en su propio proceso (node --test aísla cada archivo), así que seteamos una
// key dummy y controlamos GROQ_MAX_TOKENS / GROQ_FALLBACK_MAX_TOKENS para verificar
// los valores efectivos de max_tokens.

const reloadGroqService = () => {
  delete require.cache[require.resolve('../services/groqService')];
  return require('../services/groqService');
};

const setupEnv = ({ maxTokens, fallbackMaxTokens }) => {
  process.env.GROQ_API_KEY = 'gsk_test_dummy_key_for_unit_tests';
  if (maxTokens === undefined) delete process.env.GROQ_MAX_TOKENS;
  else process.env.GROQ_MAX_TOKENS = String(maxTokens);
  if (fallbackMaxTokens === undefined) delete process.env.GROQ_FALLBACK_MAX_TOKENS;
  else process.env.GROQ_FALLBACK_MAX_TOKENS = String(fallbackMaxTokens);
};

test('max_tokens por defecto: PRIMARY >= 320 y FALLBACK >= 256 (anti-truncamiento)', () => {
  setupEnv({});
  const groq = reloadGroqService();
  assert.equal(typeof groq.PRIMARY_MAX_TOKENS, 'number');
  assert.equal(typeof groq.FALLBACK_MAX_TOKENS, 'number');
  assert.ok(groq.PRIMARY_MAX_TOKENS >= 320, `PRIMARY_MAX_TOKENS=${groq.PRIMARY_MAX_TOKENS}`);
  assert.ok(groq.FALLBACK_MAX_TOKENS >= 256, `FALLBACK_MAX_TOKENS=${groq.FALLBACK_MAX_TOKENS}`);
});

test('max_tokens respeta override por variable de entorno', () => {
  setupEnv({ maxTokens: 500, fallbackMaxTokens: 300 });
  const groq = reloadGroqService();
  assert.equal(groq.PRIMARY_MAX_TOKENS, 500);
  assert.equal(groq.FALLBACK_MAX_TOKENS, 300);
});
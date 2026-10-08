'use strict';

// Unit tests for the AES-256-GCM secret crypto util used to protect
// per-company MercadoPago credentials at rest.
//
// The module resolves PAYMENT_SECRET_KEY lazily on every call, so each test can
// exercise the configured / missing / invalid key paths without re-importing.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const HEX_KEY = 'a'.repeat(64); // 32 bytes as hex
process.env.PAYMENT_SECRET_KEY = HEX_KEY;

const {
  encryptSecret,
  decryptSecret,
  serialize,
  parse,
  assertKeyConfigured,
  CryptoConfigError,
  CryptoError,
} = require('../lib/crypto');

// ── Key configuration ────────────────────────────────────────────────────────

test('assertKeyConfigured resolves for a valid hex key', () => {
  assert.doesNotThrow(() => assertKeyConfigured());
});

test('assertKeyConfigured throws CryptoConfigError when PAYMENT_SECRET_KEY is missing', () => {
  const saved = process.env.PAYMENT_SECRET_KEY;
  delete process.env.PAYMENT_SECRET_KEY;
  try {
    assert.throws(
      () => assertKeyConfigured(),
      (error) =>
        error instanceof CryptoConfigError &&
        error.code === 'CRYPTO_CONFIG_ERROR',
    );
  } finally {
    process.env.PAYMENT_SECRET_KEY = saved;
  }
});

test('encryptSecret throws CryptoConfigError on a wrong-length key', () => {
  const saved = process.env.PAYMENT_SECRET_KEY;
  process.env.PAYMENT_SECRET_KEY = 'too-short';
  try {
    assert.throws(() => encryptSecret('x'), CryptoConfigError);
  } finally {
    process.env.PAYMENT_SECRET_KEY = saved;
  }
});

test('accepts a 32-byte base64 PAYMENT_SECRET_KEY (triangulation)', () => {
  const saved = process.env.PAYMENT_SECRET_KEY;
  process.env.PAYMENT_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const parts = encryptSecret('b64-key-token');
    assert.equal(decryptSecret(parts), 'b64-key-token');
  } finally {
    process.env.PAYMENT_SECRET_KEY = saved;
  }
});

// ── Round-trip ───────────────────────────────────────────────────────────────

test('encryptSecret/decryptSecret round-trips a real access token', () => {
  const plaintext = 'APP_USR-1234567890-abcdef-secret';
  const parts = encryptSecret(plaintext);

  assert.equal(parts.keyVersion, 'v1');
  assert.equal(typeof parts.ciphertext, 'string');
  assert.notEqual(parts.ciphertext, plaintext);
  assert.equal(decryptSecret(parts), plaintext);
});

test('encryptSecret uses a fresh random IV per record', () => {
  const first = encryptSecret('same-token');
  const second = encryptSecret('same-token');

  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(decryptSecret(first), 'same-token');
  assert.equal(decryptSecret(second), 'same-token');
});

// ── Serialization contract ───────────────────────────────────────────────────

test('serialize/parse keep the v1:iv:tag:ciphertext contract', () => {
  const parts = encryptSecret('token-value');
  const serialized = serialize(parts);

  assert.equal(serialized.split(':')[0], 'v1');
  assert.equal(serialized.split(':').length, 4);
  assert.deepEqual(parse(serialized), parts);
  assert.equal(decryptSecret(parse(serialized)), 'token-value');
});

test('parse rejects a malformed serialized secret', () => {
  assert.throws(() => parse('not-a-valid-payload'), CryptoError);
});

// ── Tamper / failure modes ───────────────────────────────────────────────────

test('decryptSecret rejects a tampered auth tag', () => {
  const parts = encryptSecret('tamper-me');
  const tag = Buffer.from(parts.authTag, 'base64');
  tag[0] ^= 0xff;

  assert.throws(
    () => decryptSecret({ ...parts, authTag: tag.toString('base64') }),
    CryptoError,
  );
});

test('decryptSecret rejects a tampered ciphertext', () => {
  const parts = encryptSecret('tamper-me');
  const ciphertext = Buffer.from(parts.ciphertext, 'base64');
  ciphertext[0] ^= 0xff;

  assert.throws(
    () => decryptSecret({ ...parts, ciphertext: ciphertext.toString('base64') }),
    CryptoError,
  );
});

test('decryptSecret rejects ciphertext encrypted with a different key', () => {
  const parts = encryptSecret('cross-key');
  const saved = process.env.PAYMENT_SECRET_KEY;
  process.env.PAYMENT_SECRET_KEY = 'b'.repeat(64);
  try {
    assert.throws(() => decryptSecret(parts), CryptoError);
  } finally {
    process.env.PAYMENT_SECRET_KEY = saved;
  }
});

test('decryptSecret rejects a malformed payload', () => {
  assert.throws(
    () => decryptSecret({ ciphertext: '', iv: '', authTag: '' }),
    CryptoError,
  );
});

// ── No plaintext leaks ───────────────────────────────────────────────────────

test('encrypt/decrypt never log the plaintext', () => {
  const logs = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logs.push(args.join(' '));
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const plaintext = 'super-secret-token-value';
    const parts = encryptSecret(plaintext);
    decryptSecret(parts);
    assert.ok(
      !logs.some((line) => line.includes(plaintext)),
      'plaintext leaked to the console',
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

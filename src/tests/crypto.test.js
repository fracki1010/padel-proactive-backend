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

// ── Key rotation ─────────────────────────────────────────────────────────────

const withEnv = (overrides, fn) => {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
};

test('stamps the configured current key version', () => {
  withEnv(
    { PAYMENT_SECRET_KEY_VERSION: 'v3', PAYMENT_SECRET_KEY: 'e'.repeat(64) },
    () => {
      const parts = encryptSecret('stamped-secret');
      assert.equal(parts.keyVersion, 'v3');
      assert.equal(decryptSecret(parts), 'stamped-secret');
    },
  );
});

test('decrypts a v1 record after rotating the current key to v2', () => {
  const v1Key = 'a'.repeat(64);
  const v2Key = 'd'.repeat(64);
  let v1Record;

  withEnv(
    {
      PAYMENT_SECRET_KEY: v1Key,
      PAYMENT_SECRET_KEY_VERSION: 'v1',
      PAYMENT_SECRET_KEY_V1: undefined,
    },
    () => {
      v1Record = encryptSecret('legacy-secret');
    },
  );
  assert.equal(v1Record.keyVersion, 'v1');

  withEnv(
    {
      PAYMENT_SECRET_KEY: v2Key,
      PAYMENT_SECRET_KEY_VERSION: 'v2',
      PAYMENT_SECRET_KEY_V1: v1Key,
    },
    () => {
      const rotated = encryptSecret('fresh-secret');
      assert.equal(rotated.keyVersion, 'v2');
      assert.equal(decryptSecret(rotated), 'fresh-secret');
      assert.equal(decryptSecret(v1Record), 'legacy-secret');
    },
  );
});

test('fails closed for an unknown key version', () => {
  const parts = encryptSecret('versioned');
  assert.throws(
    () => decryptSecret({ ...parts, keyVersion: 'v99' }),
    (error) => error instanceof CryptoConfigError,
  );
});

test('fails closed when the historical key for a version is missing', () => {
  withEnv(
    {
      PAYMENT_SECRET_KEY: 'a'.repeat(64),
      PAYMENT_SECRET_KEY_VERSION: 'v2',
      PAYMENT_SECRET_KEY_V1: undefined,
    },
    () => {
      const parts = {
        ciphertext: 'aaaa',
        iv: 'bbbb',
        authTag: 'cccc',
        keyVersion: 'v1',
      };
      assert.throws(
        () => decryptSecret(parts),
        (error) => error instanceof CryptoConfigError,
      );
    },
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

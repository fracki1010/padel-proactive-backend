'use strict';

// AES-256-GCM helpers for secrets stored at rest (e.g. per-company MercadoPago
// access tokens). The master key comes from PAYMENT_SECRET_KEY (32 bytes, hex,
// base64 or raw utf8). Every record gets its own random 12-byte IV and a
// 16-byte authentication tag. Plaintext and ciphertext are never logged.

const crypto = require('crypto');

const DEFAULT_KEY_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;
const HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;

class CryptoConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CryptoConfigError';
    this.code = 'CRYPTO_CONFIG_ERROR';
  }
}

class CryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CryptoError';
    this.code = 'CRYPTO_ERROR';
  }
}

const resolveKey = () => {
  const raw = String(process.env.PAYMENT_SECRET_KEY || '').trim();
  if (!raw) {
    throw new CryptoConfigError(
      'PAYMENT_SECRET_KEY is not configured.',
    );
  }

  let key = null;
  if (HEX_KEY_REGEX.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    const utf8 = Buffer.from(raw, 'utf8');
    if (utf8.length === KEY_LENGTH_BYTES) {
      key = utf8;
    } else {
      const base64 = Buffer.from(raw, 'base64');
      if (base64.length === KEY_LENGTH_BYTES) {
        key = base64;
      }
    }
  }

  if (!key || key.length !== KEY_LENGTH_BYTES) {
    throw new CryptoConfigError(
      'PAYMENT_SECRET_KEY must decode to 32 bytes (hex, base64 or raw).',
    );
  }

  return key;
};

const assertKeyConfigured = () => {
  resolveKey();
};

const encryptSecret = (plaintext) => {
  const key = resolveKey();
  if (plaintext === undefined || plaintext === null) {
    throw new CryptoError('Cannot encrypt an empty secret.');
  }

  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    keyVersion: DEFAULT_KEY_VERSION,
  };
};

const decryptSecret = ({ ciphertext, iv, authTag } = {}) => {
  const key = resolveKey();
  if (!ciphertext || !iv || !authTag) {
    throw new CryptoError('Malformed ciphertext payload.');
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    throw new CryptoError(
      'Failed to decrypt secret: invalid key or corrupted ciphertext.',
    );
  }
};

const serialize = ({ keyVersion, iv, authTag, ciphertext } = {}) =>
  [
    keyVersion || DEFAULT_KEY_VERSION,
    iv || '',
    authTag || '',
    ciphertext || '',
  ].join(':');

const parse = (serialized) => {
  const parts = String(serialized || '').split(':');
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
    throw new CryptoError('Malformed serialized secret.');
  }
  return {
    keyVersion: parts[0],
    iv: parts[1],
    authTag: parts[2],
    ciphertext: parts[3],
  };
};

module.exports = {
  ALGORITHM,
  DEFAULT_KEY_VERSION,
  CryptoConfigError,
  CryptoError,
  assertKeyConfigured,
  decryptSecret,
  encryptSecret,
  parse,
  serialize,
};

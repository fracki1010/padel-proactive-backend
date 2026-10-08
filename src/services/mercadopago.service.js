'use strict';

// MercadoPago Checkout Pro integration for booking deposits (seña).
// The per-club access token is decrypted on demand; the webhook HMAC is
// verified against the club's encrypted webhook secret. No SDK is used:
// MercadoPago is called over REST with axios. All HTTP and credential access
// is injectable so tests can run without network or database.

const crypto = require('crypto');
const axios = require('axios');

const {
  decryptCredentialToken,
  decryptWebhookSecret,
  getActiveCredential,
  listActiveCredentialsForWebhook,
} = require('./paymentCredential.service');
const { CryptoConfigError } = require('../lib/crypto');

const MP_API_BASE_URL =
  process.env.MERCADOPAGO_API_BASE_URL || 'https://api.mercadopago.com';
const CHECKOUT_PREFERENCES_PATH = '/checkout/preferences';
const PAYMENTS_PATH = '/v1/payments';
const CURRENCY_ID = 'ARS';
const SIGNATURE_TOLERANCE_SECONDS = 300;
const MILLISECONDS_THRESHOLD = 1e12;
const DEFAULT_TIMEOUT_MS = 10000;
const WEBHOOK_PROVIDER = 'mercadopago';
const SECRET_CACHE_TTL_MS = 30000;
const SECRET_CACHE_MAX_ENTRIES = 500;

class SignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignatureError';
    this.code = 'SIGNATURE_ERROR';
    this.statusCode = 401;
  }
}

class MercadoPagoError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'MercadoPagoError';
    this.code = 'MERCADOPAGO_ERROR';
    this.statusCode = statusCode;
  }
}

const resolveHttpClient = (options) => options.httpClient || axios;
const resolveCredentialModel = (options) =>
  options && options.credentialModel ? options.credentialModel : undefined;

// Maps any transport/HTTP failure from MercadoPago to a 502 so callers never
// see raw axios errors and can return a stable response. The booking is not
// touched by preference creation, so a retry is always allowed.
const mapMercadoPagoError = (error) => {
  if (error instanceof MercadoPagoError) return error;
  const status = Number(error?.response?.status);
  if (Number.isFinite(status) && status >= 400 && status < 500) {
    return new MercadoPagoError('MercadoPago rejected the request.', 502);
  }
  return new MercadoPagoError('MercadoPago request failed.', 502);
};

// ── Webhook signature ────────────────────────────────────────────────────────

const parseSignatureHeader = (header) => {
  const parts = String(header || '').split(',');
  const parsed = {};
  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) parsed[key] = value;
  }
  return { ts: parsed.ts, hash: parsed.v1 };
};

const isFreshTimestamp = (ts, nowMs) => {
  const value = Number(ts);
  if (!Number.isFinite(value)) return false;
  // MP may send seconds (10 digits) or milliseconds (13 digits); normalize to
  // seconds before applying the skew window.
  const seconds =
    value > MILLISECONDS_THRESHOLD ? Math.floor(value / 1000) : Math.floor(value);
  return Math.abs(Math.floor(nowMs / 1000) - seconds) <= SIGNATURE_TOLERANCE_SECONDS;
};

// Per the MercadoPago spec the manifest id is the payment id from the query
// param (`data.id` / `id`) and MUST be lowercased when alphanumeric.
const normalizeManifestId = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  return /[a-z]/i.test(raw) ? raw.toLowerCase() : raw;
};

const buildSignatureManifest = ({ paymentId, requestId, ts }) =>
  `id:${normalizeManifestId(paymentId) || ''};request-id:${requestId};ts:${ts};`;

const computeSignature = ({ secret, paymentId, requestId, ts }) =>
  crypto
    .createHmac('sha256', String(secret))
    .update(buildSignatureManifest({ paymentId, requestId, ts }))
    .digest('hex');

// Verifies the MercadoPago `x-signature` manifest for a payment event. Throws
// SignatureError on any missing header, skew, id mismatch or HMAC mismatch.
const verifyWebhookSignature = ({ headers = {}, paymentId, secret, now = Date.now() }) => {
  if (!secret) {
    throw new SignatureError('Missing MercadoPago webhook secret.');
  }
  const requestId = headers['x-request-id'];
  const { ts, hash } = parseSignatureHeader(headers['x-signature']);
  if (!ts || !hash || !requestId) {
    throw new SignatureError('Missing MercadoPago signature headers.');
  }
  if (!isFreshTimestamp(ts, now)) {
    throw new SignatureError('MercadoPago signature timestamp outside tolerance.');
  }

  const expected = computeSignature({ secret, paymentId, requestId, ts });
  const providedBuffer = Buffer.from(hash, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new SignatureError('Invalid MercadoPago signature.');
  }
  return true;
};

// Small bounded TTL cache of decrypted webhook secrets, keyed by the stored
// ciphertext, so repeated webhook bursts do not re-decrypt on every request.
// Never caches failures; entries are dropped after the TTL.
// STALENESS: a deactivated/rotated club secret stays verifiable for up to the
// TTL (30s) — acceptable for replay/forgery windows. No cross-club leak: the
// key includes companyId + ciphertext, so one club's secret never verifies
// another club's signature.
const webhookSecretCache = new Map();

const decryptWebhookSecretCached = (credential) => {
  const cacheKey = `${credential.companyId}:${credential.webhookSecretCiphertext}:${credential.keyVersion}`;
  const now = Date.now();
  const cached = webhookSecretCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = decryptWebhookSecret(credential);
  if (webhookSecretCache.size >= SECRET_CACHE_MAX_ENTRIES) {
    const oldestKey = webhookSecretCache.keys().next().value;
    webhookSecretCache.delete(oldestKey);
  }
  webhookSecretCache.set(cacheKey, { value, expiresAt: now + SECRET_CACHE_TTL_MS });
  return value;
};

// Derives the company from the credential whose webhook secret verifies the
// signature. The payload is NEVER trusted for identity. `mpUserId` (the MP
// account id) is a cheap LOOKUP hint that only narrows the candidate set.
const resolveCompanyFromSignature = async (
  { headers, paymentId, mpUserId, now },
  options = {},
) => {
  const credentials = await listActiveCredentialsForWebhook(
    { mpUserId },
    { model: resolveCredentialModel(options) },
  );

  for (const credential of credentials) {
    let secret;
    try {
      secret = decryptWebhookSecretCached(credential);
    } catch (error) {
      // A missing/misconfigured master key is a 503, not an unmatched 401.
      if (error instanceof CryptoConfigError) throw error;
      continue;
    }
    try {
      verifyWebhookSignature({ headers, paymentId, secret, now });
      return { companyId: credential.companyId, credential, secret };
    } catch (error) {
      if (error instanceof SignatureError) continue;
      throw error;
    }
  }

  throw new SignatureError('No matching MercadoPago credential.');
};

// ── Checkout Pro ─────────────────────────────────────────────────────────────

const resolveActiveCredential = async (companyId, options = {}) => {
  if (options.credential) return options.credential;
  return getActiveCredential(companyId, {
    model: resolveCredentialModel(options),
  });
};

// Creates a Checkout Pro preference for a booking's deposit. The amount is the
// configured fixed seña; `external_reference` carries the booking id so the
// webhook can link the payment back. The club token is used and never logged.
const createDepositPreference = async (payload = {}, options = {}) => {
  const { companyId, booking, depositAmount, backUrls, notificationUrl } = payload;
  const credential = await resolveActiveCredential(companyId, options);
  if (!credential || credential.isActive === false) {
    throw new MercadoPagoError('MercadoPago is not configured for this club.', 409);
  }

  const amount = Number(depositAmount);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new MercadoPagoError('Invalid deposit amount.', 400);
  }

  const bookingId = String(booking?._id || booking?.id || '');
  if (!bookingId) {
    throw new MercadoPagoError('Missing booking for the deposit preference.', 400);
  }

  const token = decryptCredentialToken(credential);
  const body = {
    items: [
      {
        title: 'Seña de reserva',
        quantity: 1,
        currency_id: CURRENCY_ID,
        unit_price: amount,
      },
    ],
    external_reference: bookingId,
  };
  if (backUrls && typeof backUrls === 'object') {
    body.back_urls = backUrls;
  }
  // Prefer an explicit caller value, then the shared env configuration. The MP
  // dashboard notification URL is the fallback if neither is set.
  const resolvedNotificationUrl =
    notificationUrl ||
    options.notificationUrl ||
    process.env.MERCADOPAGO_NOTIFICATION_URL;
  if (resolvedNotificationUrl) {
    body.notification_url = resolvedNotificationUrl;
  }

  try {
    const { data } = await resolveHttpClient(options).post(
      `${MP_API_BASE_URL}${CHECKOUT_PREFERENCES_PATH}`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      },
    );

    return {
      preferenceId: data?.id ? String(data.id) : '',
      initPoint: data?.init_point || '',
      sandboxInitPoint: data?.sandbox_init_point || '',
    };
  } catch (error) {
    throw mapMercadoPagoError(error);
  }
};

// Fetches a payment by id with the club token. It ALWAYS loads the full
// credential by companyId: webhook signature verification uses a projected
// candidate that intentionally excludes tokenCiphertext/iv/authTag, so a caller
// must never hand that projected document here to derive the token.
const getPayment = async ({ companyId, paymentId }, options = {}) => {
  const activeCredential = await getActiveCredential(companyId, {
    model: resolveCredentialModel(options),
  });
  if (!activeCredential || activeCredential.isActive === false) {
    throw new MercadoPagoError('MercadoPago is not configured for this club.', 409);
  }

  const token = decryptCredentialToken(activeCredential);
  try {
    const { data } = await resolveHttpClient(options).get(
      `${MP_API_BASE_URL}${PAYMENTS_PATH}/${encodeURIComponent(paymentId)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      },
    );
    return data;
  } catch (error) {
    throw mapMercadoPagoError(error);
  }
};

module.exports = {
  CURRENCY_ID,
  MP_API_BASE_URL,
  MercadoPagoError,
  SIGNATURE_TOLERANCE_SECONDS,
  SignatureError,
  WEBHOOK_PROVIDER,
  buildSignatureManifest,
  computeSignature,
  createDepositPreference,
  getPayment,
  normalizeManifestId,
  resolveCompanyFromSignature,
  verifyWebhookSignature,
};

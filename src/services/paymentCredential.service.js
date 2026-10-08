'use strict';

// Credential lifecycle for per-company payment providers (MercadoPago).
// Tokens and webhook secrets are encrypted with AES-256-GCM before they touch
// the database. The HTTP-facing API only ever consumes `getMaskedCredential`,
// which strips every secret and never loads ciphertext from the database.
// `getActiveCredential` and `decryptCredentialToken` are internal accessors for
// payment services (e.g. building a Checkout preference) and MUST NOT be wired
// into a response. All reads and writes are scoped by companyId.

const PaymentCredential = require('../models/paymentCredential.model');
const { encryptSecret, decryptSecret } = require('../lib/crypto');

const PAYMENT_PROVIDER = 'mercadopago';
const MASKED_TOKEN = '••••';
const WEBHOOK_SCAN_LIMIT = 50;

// Field selection for webhook signature verification: only what is needed to
// decrypt the webhook secret. The club access token is never loaded.
const WEBHOOK_CANDIDATE_PROJECTION = {
  companyId: 1,
  mpUserId: 1,
  isActive: 1,
  webhookSecretCiphertext: 1,
  webhookSecretIv: 1,
  webhookSecretAuthTag: 1,
  keyVersion: 1,
};

// Never loaded by the HTTP-facing masked read, so request-time responses cannot
// accidentally serialize ciphertext or key material.
const SECRET_PROJECTION = {
  tokenCiphertext: 0,
  iv: 0,
  authTag: 0,
  keyVersion: 0,
  webhookSecretCiphertext: 0,
  webhookSecretIv: 0,
  webhookSecretAuthTag: 0,
};

const resolveModel = (options) => (options && options.model) || PaymentCredential;

const buildCredentialFilter = (companyId) => ({
  companyId,
  provider: PAYMENT_PROVIDER,
});

// Internal-only: decrypts the stored access token for payment providers.
const decryptCredentialToken = (credential) => {
  if (!credential || !credential.tokenCiphertext) {
    throw new Error('Credential has no token to decrypt.');
  }
  return decryptSecret({
    ciphertext: credential.tokenCiphertext,
    iv: credential.iv,
    authTag: credential.authTag,
    keyVersion: credential.keyVersion,
  });
};

// Internal-only: decrypts the stored webhook secret used to verify the
// MercadoPago webhook HMAC. Throws when the club never configured a secret.
const decryptWebhookSecret = (credential) => {
  if (!credential || !credential.webhookSecretCiphertext) {
    throw new Error('Credential has no webhook secret to decrypt.');
  }
  return decryptSecret({
    ciphertext: credential.webhookSecretCiphertext,
    iv: credential.webhookSecretIv,
    authTag: credential.webhookSecretAuthTag,
    keyVersion: credential.keyVersion,
  });
};

// Internal-only: returns the full credential document (including ciphertext).
const getActiveCredential = async (companyId, options = {}) =>
  resolveModel(options).findOne({
    ...buildCredentialFilter(companyId),
    isActive: true,
  });

const setCredential = async (companyId, payload = {}, options = {}) => {
  const model = resolveModel(options);
  const accessToken = String(payload?.accessToken || '').trim();
  if (!accessToken) {
    const error = new Error('accessToken is required.');
    error.statusCode = 400;
    throw error;
  }

  const tokenParts = encryptSecret(accessToken);
  const update = {
    companyId,
    provider: PAYMENT_PROVIDER,
    tokenCiphertext: tokenParts.ciphertext,
    iv: tokenParts.iv,
    authTag: tokenParts.authTag,
    keyVersion: tokenParts.keyVersion,
    isActive: true,
  };

  // Merge semantics: only replace the webhook secret when a new one is sent, and
  // only update the MP user id when the caller provided it. Rotating the access
  // token must not wipe the existing encrypted webhook secret.
  const webhookSecret = String(payload?.webhookSecret || '').trim();
  if (webhookSecret) {
    const secretParts = encryptSecret(webhookSecret);
    update.webhookSecretCiphertext = secretParts.ciphertext;
    update.webhookSecretIv = secretParts.iv;
    update.webhookSecretAuthTag = secretParts.authTag;
  }
  if (payload?.mpUserId !== undefined && payload?.mpUserId !== null) {
    update.mpUserId = String(payload.mpUserId).trim();
  }

  return model.findOneAndUpdate(
    buildCredentialFilter(companyId),
    { $set: update },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
};

// Public representation: no token, no ciphertext, no token digits.
const buildMaskedCredential = (credential) => {
  if (!credential) {
    return {
      configured: false,
      provider: PAYMENT_PROVIDER,
      masked: '',
      mpUserId: '',
    };
  }

  return {
    configured: true,
    provider: credential.provider || PAYMENT_PROVIDER,
    masked: MASKED_TOKEN,
    mpUserId: String(credential.mpUserId || ''),
  };
};

const getMaskedCredential = async (companyId, options = {}) => {
  const credential = await resolveModel(options).findOne(
    { ...buildCredentialFilter(companyId), isActive: true },
    SECRET_PROJECTION,
  );
  return buildMaskedCredential(credential);
};

const deleteCredential = async (companyId, options = {}) => {
  const model = resolveModel(options);
  const result = await model.updateOne(
    { ...buildCredentialFilter(companyId), isActive: true },
    { $set: { isActive: false } },
  );
  return { deleted: Number(result?.matchedCount || 0) > 0 };
};

const listActiveCredentials = async (options = {}) =>
  resolveModel(options).find({ provider: PAYMENT_PROVIDER, isActive: true });

// Webhook candidates: optionally narrowed by the MP account id (a cheap lookup
// hint, never trusted for identity) and always bounded so a forged request
// cannot scan every club. Only secret-verification fields are selected.
//
// LIMITATION: when no hint is sent the query is bounded to WEBHOOK_SCAN_LIMIT
// candidates, so clubs beyond that count are not reached — those sign requests
// MUST include the MP account id (`body.user_id`), which MercadoPago always
// sends with payment events, narrowing to a single candidate.
const listActiveCredentialsForWebhook = async ({ mpUserId } = {}, options = {}) => {
  const filter = { provider: PAYMENT_PROVIDER, isActive: true };
  const hint = mpUserId === undefined || mpUserId === null ? '' : String(mpUserId).trim();
  if (hint) filter.mpUserId = hint;

  // Real database `.limit` (not a JS slice) so the query itself is bounded; the
  // slice is only a fallback for in-memory fakes used by tests.
  const query = resolveModel(options).find(filter, WEBHOOK_CANDIDATE_PROJECTION);
  const bounded =
    query && typeof query.limit === 'function' ? query.limit(WEBHOOK_SCAN_LIMIT) : query;
  const credentials = await bounded;
  return Array.isArray(credentials)
    ? credentials.slice(0, WEBHOOK_SCAN_LIMIT)
    : credentials;
};

module.exports = {
  MASKED_TOKEN,
  PAYMENT_PROVIDER,
  SECRET_PROJECTION,
  buildMaskedCredential,
  decryptCredentialToken,
  decryptWebhookSecret,
  deleteCredential,
  getActiveCredential,
  getMaskedCredential,
  listActiveCredentials,
  listActiveCredentialsForWebhook,
  setCredential,
};

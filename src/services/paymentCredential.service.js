'use strict';

// Credential lifecycle for per-company payment providers (MercadoPago).
// Tokens and webhook secrets are encrypted with AES-256-GCM before they touch
// the database and are never returned in plaintext. All lookups and writes are
// scoped by companyId; a caller can never read or delete another company's
// credential.

const PaymentCredential = require('../models/paymentCredential.model');
const { encryptSecret, decryptSecret } = require('../lib/crypto');

const PAYMENT_PROVIDER = 'mercadopago';
const MASKED_TOKEN = '••••';

const resolveModel = (options) => (options && options.model) || PaymentCredential;

const buildCredentialFilter = (companyId) => ({
  companyId,
  provider: PAYMENT_PROVIDER,
});

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

const setCredential = async (companyId, payload = {}, options = {}) => {
  const model = resolveModel(options);
  const accessToken = String(payload?.accessToken || '').trim();
  if (!accessToken) {
    const error = new Error('accessToken is required.');
    error.statusCode = 400;
    throw error;
  }

  const webhookSecret = String(payload?.webhookSecret || '').trim();
  const tokenParts = encryptSecret(accessToken);
  const secretParts = webhookSecret ? encryptSecret(webhookSecret) : null;

  const update = {
    companyId,
    provider: PAYMENT_PROVIDER,
    tokenCiphertext: tokenParts.ciphertext,
    iv: tokenParts.iv,
    authTag: tokenParts.authTag,
    keyVersion: tokenParts.keyVersion,
    webhookSecretCiphertext: secretParts ? secretParts.ciphertext : '',
    webhookSecretIv: secretParts ? secretParts.iv : '',
    webhookSecretAuthTag: secretParts ? secretParts.authTag : '',
    mpUserId: String(payload?.mpUserId || '').trim(),
    isActive: true,
  };

  return model.findOneAndUpdate(
    buildCredentialFilter(companyId),
    { $set: update },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );
};

const getActiveCredential = async (companyId, options = {}) =>
  resolveModel(options).findOne({
    ...buildCredentialFilter(companyId),
    isActive: true,
  });

// Builds a write-only public representation. Decrypts only to derive the last
// four digits for display; the ciphertext and the token never leave this module.
const buildMaskedCredential = (credential) => {
  if (!credential) {
    return {
      configured: false,
      provider: PAYMENT_PROVIDER,
      masked: '',
      last4: '',
      mpUserId: '',
    };
  }

  const token = decryptCredentialToken(credential);
  return {
    configured: true,
    provider: credential.provider || PAYMENT_PROVIDER,
    masked: MASKED_TOKEN,
    last4: String(token).slice(-4),
    mpUserId: String(credential.mpUserId || ''),
  };
};

const getMaskedCredential = async (companyId, options = {}) =>
  buildMaskedCredential(await getActiveCredential(companyId, options));

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

module.exports = {
  MASKED_TOKEN,
  PAYMENT_PROVIDER,
  buildMaskedCredential,
  decryptCredentialToken,
  deleteCredential,
  getActiveCredential,
  getMaskedCredential,
  listActiveCredentials,
  setCredential,
};

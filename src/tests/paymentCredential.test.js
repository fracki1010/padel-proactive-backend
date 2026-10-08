'use strict';

// Unit tests for `mercadopago-credentials`: tokens are encrypted at rest
// (AES-256-GCM), never echoed by masked GETs, and strictly scoped per company.
// Persistence runs against an in-memory fake model so cross-company isolation
// and "nothing persisted on invalid input" are proven without MongoDB.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const HEX_KEY = 'c'.repeat(64);
process.env.PAYMENT_SECRET_KEY = process.env.PAYMENT_SECRET_KEY || HEX_KEY;

const PaymentCredential = require('../models/paymentCredential.model');
const {
  PAYMENT_PROVIDER,
  setCredential,
  getActiveCredential,
  getMaskedCredential,
  deleteCredential,
  listActiveCredentials,
  decryptCredentialToken,
} = require('../services/paymentCredential.service');

const COMPANY_A = 'company-a';
const COMPANY_B = 'company-b';

// ── In-memory fake model ─────────────────────────────────────────────────────

const createFakeCredentialModel = () => {
  const store = new Map();
  const calls = { findOne: [], findOneAndUpdate: [], updateOne: [], find: [] };
  const keyOf = (companyId) => String(companyId);

  return {
    calls,
    async findOne(filter) {
      calls.findOne.push(filter);
      const doc = store.get(keyOf(filter.companyId));
      if (!doc) return null;
      if (filter.isActive === true && !doc.isActive) return null;
      return doc;
    },
    async findOneAndUpdate(filter, update, options) {
      calls.findOneAndUpdate.push({ filter, update, options });
      const doc = { ...(store.get(keyOf(filter.companyId)) || {}), ...update.$set };
      store.set(keyOf(filter.companyId), doc);
      return doc;
    },
    async updateOne(filter, update) {
      calls.updateOne.push({ filter, update });
      const doc = store.get(keyOf(filter.companyId));
      if (!doc || (filter.isActive === true && !doc.isActive)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async find(filter) {
      calls.find.push(filter);
      return [...store.values()].filter((doc) =>
        filter.isActive === true ? doc.isActive : true,
      );
    },
  };
};

// ── Model ────────────────────────────────────────────────────────────────────

test('PaymentCredential defines a unique companyId+provider index', () => {
  const indexes = PaymentCredential.schema.indexes();
  const unique = indexes.find(
    ([definition, options]) =>
      definition.companyId === 1 &&
      definition.provider === 1 &&
      options?.unique === true,
  );
  assert.ok(unique, 'missing unique (companyId, provider) index');
});

test('PaymentCredential toJSON strips every secret field', () => {
  const doc = new PaymentCredential({
    companyId: new mongoose.Types.ObjectId(),
    provider: PAYMENT_PROVIDER,
    tokenCiphertext: 'token-ct',
    iv: 'token-iv',
    authTag: 'token-tag',
    keyVersion: 'v1',
    webhookSecretCiphertext: 'wh-ct',
    webhookSecretIv: 'wh-iv',
    webhookSecretAuthTag: 'wh-tag',
    mpUserId: 'mp-1',
    isActive: true,
  });

  const json = doc.toJSON();
  assert.equal(json.mpUserId, 'mp-1');
  assert.equal(json.isActive, true);

  const secrets = [
    'tokenCiphertext',
    'iv',
    'authTag',
    'keyVersion',
    'webhookSecretCiphertext',
    'webhookSecretIv',
    'webhookSecretAuthTag',
    'token',
  ];
  for (const secret of secrets) {
    assert.ok(!(secret in json), `toJSON leaked ${secret}`);
  }
});

// ── Encryption at rest ───────────────────────────────────────────────────────

test('setCredential stores ciphertext, never the plaintext token', async () => {
  const model = createFakeCredentialModel();
  const token = 'APP_USR-SECRET-TOKEN-1234';

  const saved = await setCredential(
    COMPANY_A,
    { accessToken: token, mpUserId: 'mp-1' },
    { model },
  );

  assert.equal(saved.provider, PAYMENT_PROVIDER);
  assert.ok(saved.tokenCiphertext);
  assert.notEqual(saved.tokenCiphertext, token);
  assert.ok(!JSON.stringify(saved).includes(token));
  assert.equal(decryptCredentialToken(saved), token);
});

test('setCredential rejects a missing access token without persisting', async () => {
  const model = createFakeCredentialModel();

  await assert.rejects(
    setCredential(COMPANY_A, {}, { model }),
    (error) => error.statusCode === 400,
  );

  assert.equal(model.calls.findOneAndUpdate.length, 0);
});

// ── Read / masking ───────────────────────────────────────────────────────────

test('getActiveCredential returns the decrypted token for its company', async () => {
  const model = createFakeCredentialModel();
  await setCredential(COMPANY_A, { accessToken: 'token-a' }, { model });

  const credential = await getActiveCredential(COMPANY_A, { model });

  assert.ok(credential);
  assert.equal(decryptCredentialToken(credential), 'token-a');
});

test('getMaskedCredential masks the token and omits all secret fields', async () => {
  const model = createFakeCredentialModel();
  const token = 'APP_USR-MASK-TOKEN-9876';
  await setCredential(
    COMPANY_A,
    { accessToken: token, mpUserId: 'mp-9' },
    { model },
  );

  const masked = await getMaskedCredential(COMPANY_A, { model });

  assert.equal(masked.configured, true);
  assert.equal(masked.masked, '••••');
  assert.equal(masked.last4, '9876');
  assert.equal(masked.mpUserId, 'mp-9');

  const serialized = JSON.stringify(masked);
  assert.ok(!serialized.includes(token), 'masked response leaked the token');
  assert.ok(!('tokenCiphertext' in masked));
  assert.ok(!('token' in masked));
});

test('getMaskedCredential reports configured:false when none exists', async () => {
  const model = createFakeCredentialModel();

  const masked = await getMaskedCredential(COMPANY_B, { model });

  assert.equal(masked.configured, false);
  assert.equal(masked.last4, '');
});

// ── Cross-company isolation ──────────────────────────────────────────────────

test('getActiveCredential never returns another company credential', async () => {
  const model = createFakeCredentialModel();
  await setCredential(COMPANY_A, { accessToken: 'token-a' }, { model });

  const other = await getActiveCredential(COMPANY_B, { model });

  assert.equal(other, null);
  assert.equal(String(model.calls.findOne.at(-1).companyId), COMPANY_B);
});

test('deleteCredential only deactivates the caller company credential', async () => {
  const model = createFakeCredentialModel();
  await setCredential(COMPANY_A, { accessToken: 'token-a' }, { model });

  const result = await deleteCredential(COMPANY_B, { model });

  assert.equal(result.deleted, false);
  assert.ok(await getActiveCredential(COMPANY_A, { model }));
});

test('deleteCredential soft-deactivates the matching credential', async () => {
  const model = createFakeCredentialModel();
  await setCredential(COMPANY_A, { accessToken: 'token-a' }, { model });

  const result = await deleteCredential(COMPANY_A, { model });

  assert.equal(result.deleted, true);
  assert.equal(await getActiveCredential(COMPANY_A, { model }), null);
});

// ── Listing ──────────────────────────────────────────────────────────────────

test('listActiveCredentials returns only active credentials', async () => {
  const model = createFakeCredentialModel();
  await setCredential(COMPANY_A, { accessToken: 'token-a' }, { model });
  await setCredential(COMPANY_B, { accessToken: 'token-b' }, { model });
  await deleteCredential(COMPANY_B, { model });

  const active = await listActiveCredentials({ model });

  assert.equal(active.length, 1);
  assert.equal(String(active[0].companyId), COMPANY_A);
});

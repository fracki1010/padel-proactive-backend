'use strict';

// Unit tests for the MercadoPago payment service:
// - Checkout Pro preference creation (fixed seña, ARS, external_reference = booking)
// - Payment lookup by id
// - Webhook HMAC signature verification (manifest + timestamp skew)
// - Company derivation from the club's stored credential (never the payload)
// The HTTP client and credential model are injected fakes, so no network or
// database is required.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.PAYMENT_SECRET_KEY = process.env.PAYMENT_SECRET_KEY || 'c'.repeat(64);

const {
  listActiveCredentialsForWebhook,
  setCredential,
} = require('../services/paymentCredential.service');
const { CryptoConfigError } = require('../lib/crypto');
const {
  SignatureError,
  buildSignatureManifest,
  createDepositPreference,
  getPayment,
  normalizeManifestId,
  verifyWebhookSignature,
  resolveCompanyFromSignature,
} = require('../services/mercadopago.service');

const COMPANY_A = '64b0000000000000000000a1';
const COMPANY_B = '64b0000000000000000000b2';
const BOOKING_ID = '64b0000000000000000000c3';
const TOKEN_A = 'APP_USR-token-company-a';
const TOKEN_B = 'APP_USR-token-company-b';
const SECRET_A = 'webhook-secret-company-a';
const SECRET_B = 'webhook-secret-company-b';

// ── In-memory fake credential model ──────────────────────────────────────────

const createFakeCredentialModel = () => {
  const store = new Map();
  const keyOf = (companyId) => String(companyId);
  const calls = { find: [] };
  return {
    store,
    calls,
    async findOne(filter, projection) {
      const doc = store.get(keyOf(filter.companyId));
      if (!doc) return null;
      if (filter.isActive === true && !doc.isActive) return null;
      if (!projection) return doc;
      const projected = { ...doc };
      for (const key of Object.keys(projection)) {
        if (projection[key] === 0) delete projected[key];
      }
      return projected;
    },
    async findOneAndUpdate(filter, update) {
      const doc = { ...(store.get(keyOf(filter.companyId)) || {}), ...update.$set };
      store.set(keyOf(filter.companyId), doc);
      return doc;
    },
    async updateOne(filter, update) {
      const doc = store.get(keyOf(filter.companyId));
      if (!doc || (filter.isActive === true && !doc.isActive)) {
        return { matchedCount: 0, modifiedCount: 0 };
      }
      Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async find(filter, projection) {
      calls.find.push({ filter, projection });
      return [...store.values()]
        .filter((doc) => (filter.isActive === true ? doc.isActive : true))
        .filter((doc) => (filter.mpUserId ? doc.mpUserId === filter.mpUserId : true))
        .map((doc) => {
          if (!projection) return doc;
          const include = Object.keys(projection).filter(
            (key) => projection[key] === 1,
          );
          if (include.length) {
            const projected = { _id: doc._id };
            for (const key of include) projected[key] = doc[key];
            return projected;
          }
          const projected = { ...doc };
          for (const key of Object.keys(projection)) {
            if (projection[key] === 0) delete projected[key];
          }
          return projected;
        });
    },
  };
};

const seedCredentials = async (model) => {
  await setCredential(
    COMPANY_A,
    { accessToken: TOKEN_A, webhookSecret: SECRET_A, mpUserId: 'mp-account-a' },
    { model },
  );
  await setCredential(
    COMPANY_B,
    { accessToken: TOKEN_B, webhookSecret: SECRET_B, mpUserId: 'mp-account-b' },
    { model },
  );
};

const signHeaders = ({ secret, paymentId, requestId, ts }) => {
  const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;
  const hash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return {
    'x-signature': `ts=${ts},v1=${hash}`,
    'x-request-id': requestId,
  };
};

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

// ── createDepositPreference ──────────────────────────────────────────────────

test('createDepositPreference posts the fixed seña for the booking using the club token', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const captured = {};
  const httpClient = {
    async post(url, body, config) {
      captured.url = url;
      captured.body = body;
      captured.config = config;
      return { data: { id: 'pref-123', init_point: 'https://mp/checkout/pref-123' } };
    },
  };

  const result = await createDepositPreference(
    { companyId: COMPANY_A, booking: { _id: BOOKING_ID }, depositAmount: 5000 },
    { credentialModel: model, httpClient },
  );

  assert.equal(result.preferenceId, 'pref-123');
  assert.equal(result.initPoint, 'https://mp/checkout/pref-123');
  assert.match(captured.url, /\/checkout\/preferences$/);
  assert.equal(captured.body.external_reference, String(BOOKING_ID));
  assert.equal(captured.body.items[0].unit_price, 5000);
  assert.equal(captured.body.items[0].currency_id, 'ARS');
  assert.equal(captured.body.items[0].quantity, 1);
  // The club's own decrypted token — not another company's.
  assert.equal(captured.config.headers.Authorization, `Bearer ${TOKEN_A}`);
});

test('createDepositPreference surfaces a 5xx from MercadoPago as a 502 without touching the booking', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);
  const booking = { _id: BOOKING_ID, status: 'reservado' };

  const httpClient = {
    async post() {
      const error = new Error('Bad Gateway');
      error.response = { status: 502, data: { message: 'internal' } };
      throw error;
    },
  };

  await assert.rejects(
    createDepositPreference(
      { companyId: COMPANY_A, booking, depositAmount: 5000 },
      { credentialModel: model, httpClient },
    ),
    (error) => error.statusCode === 502 && error.code === 'MERCADOPAGO_ERROR',
  );
  assert.equal(booking.status, 'reservado');
});

test('createDepositPreference surfaces a MercadoPago timeout as a 502', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const httpClient = {
    async post() {
      const error = new Error('timeout of 10000ms exceeded');
      error.code = 'ECONNABORTED';
      throw error;
    },
  };

  await assert.rejects(
    createDepositPreference(
      { companyId: COMPANY_A, booking: { _id: BOOKING_ID }, depositAmount: 5000 },
      { credentialModel: model, httpClient },
    ),
    (error) => error.statusCode === 502,
  );
});

test('createDepositPreference rejects when the club has no active credential', async () => {
  const model = createFakeCredentialModel();

  await assert.rejects(
    createDepositPreference(
      { companyId: COMPANY_A, booking: { _id: BOOKING_ID }, depositAmount: 5000 },
      { credentialModel: model, httpClient: { post: async () => ({}) } },
    ),
    (error) => error.statusCode === 409,
  );
});

test('createDepositPreference uses a different club token and amount when asked', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const captured = {};
  const httpClient = {
    async post(url, body, config) {
      captured.body = body;
      captured.config = config;
      return { data: { id: 'pref-b', init_point: 'https://mp/checkout/pref-b' } };
    },
  };

  await createDepositPreference(
    { companyId: COMPANY_B, booking: { _id: BOOKING_ID }, depositAmount: 7500 },
    { credentialModel: model, httpClient },
  );

  assert.equal(captured.body.items[0].unit_price, 7500);
  assert.equal(captured.config.headers.Authorization, `Bearer ${TOKEN_B}`);
});

// ── getPayment ───────────────────────────────────────────────────────────────

test('getPayment fetches the payment with the club token', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const captured = {};
  const httpClient = {
    async get(url, config) {
      captured.url = url;
      captured.config = config;
      return {
        data: { id: 'pay-1', status: 'approved', external_reference: String(BOOKING_ID) },
      };
    },
  };

  const payment = await getPayment(
    { companyId: COMPANY_B, paymentId: 'pay-1' },
    { credentialModel: model, httpClient },
  );

  assert.equal(payment.status, 'approved');
  assert.equal(payment.external_reference, String(BOOKING_ID));
  assert.match(captured.url, /\/v1\/payments\/pay-1$/);
  assert.equal(captured.config.headers.Authorization, `Bearer ${TOKEN_B}`);
});

// ── verifyWebhookSignature ───────────────────────────────────────────────────

test('verifyWebhookSignature accepts a valid manifest signature', () => {
  const paymentId = 'pay-1';
  const ts = nowSeconds();
  const headers = signHeaders({
    secret: SECRET_A,
    paymentId,
    requestId: 'req-1',
    ts,
  });

  assert.equal(
    verifyWebhookSignature({ headers, paymentId, secret: SECRET_A }),
    true,
  );
});

test('verifyWebhookSignature rejects a mismatched request-id', () => {
  const paymentId = 'pay-1';
  const ts = nowSeconds();
  const headers = signHeaders({
    secret: SECRET_A,
    paymentId,
    requestId: 'req-1',
    ts,
  });
  headers['x-request-id'] = 'req-tampered';

  assert.throws(
    () => verifyWebhookSignature({ headers, paymentId, secret: SECRET_A }),
    (error) => error instanceof SignatureError,
  );
});

test('verifyWebhookSignature rejects a tampered timestamp', () => {
  const paymentId = 'pay-1';
  const ts = nowSeconds();
  const headers = signHeaders({
    secret: SECRET_A,
    paymentId,
    requestId: 'req-1',
    ts,
  });
  headers['x-signature'] = headers['x-signature'].replace(`ts=${ts}`, `ts=${ts}1`);

  assert.throws(
    () => verifyWebhookSignature({ headers, paymentId, secret: SECRET_A }),
    (error) => error instanceof SignatureError,
  );
});

test('verifyWebhookSignature rejects a timestamp older than five minutes', () => {
  const paymentId = 'pay-1';
  const staleTs = String(Math.floor(Date.now() / 1000) - 601);
  const headers = signHeaders({
    secret: SECRET_A,
    paymentId,
    requestId: 'req-1',
    ts: staleTs,
  });

  assert.throws(
    () => verifyWebhookSignature({ headers, paymentId, secret: SECRET_A }),
    (error) => error instanceof SignatureError,
  );
});

test('verifyWebhookSignature rejects a missing signature header', () => {
  assert.throws(
    () => verifyWebhookSignature({ headers: {}, paymentId: 'pay-1', secret: SECRET_A }),
    (error) => error instanceof SignatureError,
  );
});

// ── resolveCompanyFromSignature ──────────────────────────────────────────────

test('resolveCompanyFromSignature derives the company from the matched credential', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const paymentId = 'pay-2';
  const headers = signHeaders({
    secret: SECRET_B,
    paymentId,
    requestId: 'req-2',
    ts: nowSeconds(),
  });

  const match = await resolveCompanyFromSignature(
    { headers, paymentId },
    { credentialModel: model },
  );

  assert.equal(String(match.companyId), COMPANY_B);
});

test('resolveCompanyFromSignature rejects a signature that matches no club', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const paymentId = 'pay-3';
  const headers = signHeaders({
    secret: 'not-any-club-secret',
    paymentId,
    requestId: 'req-3',
    ts: nowSeconds(),
  });

  await assert.rejects(
    resolveCompanyFromSignature({ headers, paymentId }, { credentialModel: model }),
    (error) => error instanceof SignatureError,
  );
});

// ── Review fixes ─────────────────────────────────────────────────────────────

test('createDepositPreference passes notification_url and back_urls when provided', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const captured = {};
  const httpClient = {
    async post(url, body) {
      captured.body = body;
      return { data: { id: 'pref-n', init_point: 'https://mp/checkout/pref-n' } };
    },
  };

  await createDepositPreference(
    {
      companyId: COMPANY_A,
      booking: { _id: BOOKING_ID },
      depositAmount: 5000,
      backUrls: {
        success: 'https://portal/success',
        failure: 'https://portal/failure',
        pending: 'https://portal/pending',
      },
    },
    {
      credentialModel: model,
      httpClient,
      notificationUrl: 'https://api.example.com/webhooks/mercadopago',
    },
  );

  assert.equal(
    captured.body.notification_url,
    'https://api.example.com/webhooks/mercadopago',
  );
  assert.equal(captured.body.back_urls.success, 'https://portal/success');
});

test('verifyWebhookSignature accepts a millisecond timestamp', () => {
  const paymentId = 'pay-1';
  const ts = String(Date.now());
  const headers = signHeaders({
    secret: SECRET_A,
    paymentId,
    requestId: 'req-ms',
    ts,
  });

  assert.equal(
    verifyWebhookSignature({ headers, paymentId, secret: SECRET_A }),
    true,
  );
});

test('verifyWebhookSignature rejects a stale millisecond timestamp', () => {
  const paymentId = 'pay-1';
  const ts = String(Date.now() - 10 * 60 * 1000);
  const headers = signHeaders({
    secret: SECRET_A,
    paymentId,
    requestId: 'req-ms-stale',
    ts,
  });

  assert.throws(
    () => verifyWebhookSignature({ headers, paymentId, secret: SECRET_A }),
    (error) => error instanceof SignatureError,
  );
});

test('normalizeManifestId lowercases alphanumeric ids and the manifest uses it', () => {
  assert.equal(normalizeManifestId('AbC123'), 'abc123');
  assert.equal(normalizeManifestId(12345), '12345');
  assert.equal(normalizeManifestId(''), null);
  assert.equal(
    buildSignatureManifest({ paymentId: 'AbC123', requestId: 'r1', ts: '99' }),
    'id:abc123;request-id:r1;ts:99;',
  );
});

test('resolveCompanyFromSignature surfaces a missing master key as CryptoConfigError', async () => {
  const model = {
    async find() {
      return [
        {
          companyId: COMPANY_A,
          mpUserId: '',
          isActive: true,
          webhookSecretCiphertext: 'ct',
          webhookSecretIv: 'iv',
          webhookSecretAuthTag: 'tag',
          // Unknown key version with no historical env key -> CryptoConfigError.
          keyVersion: 'v99',
        },
      ];
    },
  };

  await assert.rejects(
    resolveCompanyFromSignature(
      { headers: {}, paymentId: 'pay-x' },
      { credentialModel: model },
    ),
    (error) => error instanceof CryptoConfigError,
  );
});

test('resolveCompanyFromSignature with a hint only queries the hinted MP account', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const paymentId = 'pay-hint';
  const headers = signHeaders({
    secret: SECRET_B,
    paymentId,
    requestId: 'req-hint',
    ts: nowSeconds(),
  });

  const match = await resolveCompanyFromSignature(
    { headers, paymentId, mpUserId: 'mp-account-b' },
    { credentialModel: model },
  );

  assert.equal(String(match.companyId), COMPANY_B);
  const lastFind = model.calls.find.at(-1);
  assert.equal(lastFind.filter.mpUserId, 'mp-account-b');
  // Field selection: the club access token is never selected for webhooks;
  // only the webhook-secret fields are included.
  assert.ok(
    !('tokenCiphertext' in lastFind.projection),
    'webhook query must not select the access token',
  );
  assert.equal(lastFind.projection.webhookSecretCiphertext, 1);
});

test('resolveCompanyFromSignature falls back to a bounded scan without a hint', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const paymentId = 'pay-nohint';
  const headers = signHeaders({
    secret: SECRET_A,
    paymentId,
    requestId: 'req-nohint',
    ts: nowSeconds(),
  });

  const match = await resolveCompanyFromSignature(
    { headers, paymentId },
    { credentialModel: model },
  );

  assert.equal(String(match.companyId), COMPANY_A);
  const lastFind = model.calls.find.at(-1);
  assert.equal(lastFind.filter.mpUserId, undefined);
});

// ── Re-judge fixes ───────────────────────────────────────────────────────────

test('getPayment loads the full credential even when handed the webhook-projected candidate', async () => {
  const model = createFakeCredentialModel();
  await seedCredentials(model);

  const paymentId = 'pay-full';
  const headers = signHeaders({
    secret: SECRET_A,
    paymentId,
    requestId: 'req-full',
    ts: nowSeconds(),
  });
  // Real webhook signature verification yields the PROJECTED candidate.
  const match = await resolveCompanyFromSignature(
    { headers, paymentId },
    { credentialModel: model },
  );
  assert.equal(
    match.credential.tokenCiphertext,
    undefined,
    'the signature candidate must not carry the access token',
  );
  assert.ok(match.credential.webhookSecretCiphertext);

  const captured = {};
  const httpClient = {
    async get(url, config) {
      captured.url = url;
      captured.config = config;
      return {
        data: { id: paymentId, status: 'approved', external_reference: BOOKING_ID },
      };
    },
  };

  // Mimics the webhook call shape: the projected candidate is passed but the
  // service must load the full credential itself to decrypt the token.
  const payment = await getPayment(
    { companyId: match.companyId, paymentId, credential: match.credential },
    { credentialModel: model, httpClient },
  );

  assert.equal(payment.status, 'approved');
  assert.equal(captured.config.headers.Authorization, `Bearer ${TOKEN_A}`);
});

test('listActiveCredentialsForWebhook bounds the query with a real database limit', async () => {
  const calls = {};
  const model = {
    find(filter, projection) {
      calls.filter = filter;
      calls.projection = projection;
      return {
        limit(value) {
          calls.limit = value;
          return Promise.resolve([]);
        },
      };
    },
  };

  await listActiveCredentialsForWebhook({ mpUserId: 'mp-a' }, { model });

  assert.equal(calls.limit, 50, 'must use a real .limit, not a JS slice');
  assert.equal(calls.filter.mpUserId, 'mp-a');
  assert.ok(!('tokenCiphertext' in calls.projection));
});

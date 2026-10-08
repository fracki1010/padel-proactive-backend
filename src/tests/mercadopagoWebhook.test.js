'use strict';

// Integration tests for the MercadoPago webhook handler using in-memory fakes.
// Corrected semantics (review findings):
// - dedupe represents APPLIED terminal transitions only; pending/created events
//   are answered 200 without persisting so a later `approved` still applies
// - apply/fetch failures return 5xx so MercadoPago retries (no lost payments)
// - the processed row is written only after a successful, ownership-scoped apply
// - a body-only companyId can never forge an event
// Also asserts the raw-body mount happens before the global JSON parser.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-webhook';

const ProcessedWebhook = require('../models/processedWebhook.model');
const { CryptoConfigError } = require('../lib/crypto');
const { SignatureError, verifyWebhookSignature } = require('../services/mercadopago.service');
const {
  WEBHOOK_RATE_LIMIT_MAX,
  createWebhookHandler,
  createWebhookRouter,
  webhookRateLimiter,
} = require('../routes/webhook.routes');

const COMPANY = '64b0000000000000000000a1';
const BOOKING_ID = '64b0000000000000000000c3';
const PAYMENT_ID = 'pay-777';
const SECRET = 'club-webhook-secret';

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

const signHeaders = ({ secret, paymentId, requestId, ts }) => {
  const manifest = `id:${String(paymentId).toLowerCase()};request-id:${requestId};ts:${ts};`;
  const hash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return { 'x-signature': `ts=${ts},v1=${hash}`, 'x-request-id': requestId };
};

// Resolver that performs the REAL signature verification and yields a company.
const makeResolver = (secret, companyId) => async ({ headers, paymentId }) => {
  verifyWebhookSignature({ headers, paymentId, secret });
  return { companyId, credential: { stub: true } };
};

const createResponse = () => ({
  statusCode: undefined,
  payload: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.payload = body;
    return this;
  },
});

const invoke = async (handler, { headers = {}, body = {}, query = {} }) => {
  const res = createResponse();
  await handler({ headers, query, body: Buffer.from(JSON.stringify(body)) }, res);
  return res;
};

const paymentBody = (extra = {}) => ({
  type: 'payment',
  action: 'payment.updated',
  data: { id: PAYMENT_ID },
  ...extra,
});

// Handler deps with an in-memory "applied" set and a recorder for the legacy
// markProcessed callback so regressions to the old flow are observable.
const createDeps = (overrides = {}) => {
  const applied = new Set();
  const legacy = [];
  return {
    applied,
    legacy,
    deps: {
      resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
      isAlreadyApplied: async ({ paymentId }) => applied.has(paymentId),
      markApplied: async ({ paymentId }) => {
        applied.add(paymentId);
      },
      markProcessed: async (doc) => {
        legacy.push(doc);
      },
      getPayment: async () => ({
        id: PAYMENT_ID,
        status: 'approved',
        external_reference: BOOKING_ID,
      }),
      applyApprovedPayment: async () => ({ applied: true }),
      ...overrides,
    },
  };
};

// ── Model ────────────────────────────────────────────────────────────────────

test('ProcessedWebhook defines a unique provider+paymentId index and an applied status', () => {
  const indexes = ProcessedWebhook.schema.indexes();
  const unique = indexes.find(
    ([definition, options]) =>
      definition.provider === 1 &&
      definition.paymentId === 1 &&
      options?.unique === true,
  );
  assert.ok(unique, 'missing unique (provider, paymentId) index');
  assert.ok(
    ProcessedWebhook.schema.path('status'),
    'missing status field used to gate dedupe on applied only',
  );
});

test('default isAlreadyApplied only dedupes records with status=applied', async () => {
  const store = [];
  const model = {
    async findOne(filter) {
      return (
        store.find(
          (record) =>
            record.provider === filter.provider &&
            record.paymentId === filter.paymentId &&
            (!filter.status || record.status === filter.status),
        ) || null
      );
    },
    async create(doc) {
      store.push({ ...doc });
      return doc;
    },
  };

  // A pending/failed record for the payment must NOT dedupe. Uses the DEFAULT
  // model-backed isAlreadyApplied / markApplied (no overrides).
  store.push({ provider: 'mercadopago', paymentId: PAYMENT_ID, status: 'failed' });
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    markProcessed: async () => {},
    processedWebhookModel: model,
    getPayment: async () => ({ status: 'approved', external_reference: BOOKING_ID }),
    applyApprovedPayment: async () => ({ applied: true }),
  });
  const retryable = await invoke(handler, {
    headers: signHeaders({
      secret: SECRET,
      paymentId: PAYMENT_ID,
      requestId: 'req-status',
      ts: nowSeconds(),
    }),
    body: paymentBody(),
  });
  assert.equal(retryable.statusCode, 200);
  assert.equal(retryable.payload.applied, true);
  assert.ok(
    store.some((record) => record.status === 'applied'),
    'a successful apply must persist an applied record',
  );

  // An applied record for the same payment DOES dedupe.
  let fetchCount = 0;
  const dup = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    markProcessed: async () => {},
    processedWebhookModel: model,
    getPayment: async () => {
      fetchCount += 1;
      return { status: 'approved', external_reference: BOOKING_ID };
    },
    applyApprovedPayment: async () => ({ applied: true }),
  });
  const res = await invoke(dup, {
    headers: signHeaders({
      secret: SECRET,
      paymentId: PAYMENT_ID,
      requestId: 'req-dup-status',
      ts: nowSeconds(),
    }),
    body: paymentBody(),
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.duplicate, true);
  assert.equal(fetchCount, 0, 'an applied payment must not be fetched again');
});

// ── Approval flow ────────────────────────────────────────────────────────────

test('a signed approval applies the transition and persists an applied record', async () => {
  const { deps, applied, legacy } = createDeps();

  const handler = createWebhookHandler(deps);
  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-appr',
    ts: nowSeconds(),
  });
  // A malicious body-supplied companyId must be ignored; the query param id is
  // used for the manifest.
  const res = await invoke(handler, {
    headers,
    query: { 'data.id': PAYMENT_ID },
    body: paymentBody({ user_id: 'mp-account', companyId: 'attacker-company' }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.applied, true);
  assert.equal(applied.has(PAYMENT_ID), true);
  assert.equal(legacy.length, 0, 'legacy pre-apply markProcessed must not be used');
});

test('a duplicate of the same approved event is deduped', async () => {
  const { deps, applied } = createDeps();
  applied.add(PAYMENT_ID);
  let fetchCount = 0;
  deps.getPayment = async () => {
    fetchCount += 1;
    return { status: 'approved', external_reference: BOOKING_ID };
  };
  let applyCount = 0;
  deps.applyApprovedPayment = async () => {
    applyCount += 1;
    return { applied: true };
  };

  const handler = createWebhookHandler(deps);
  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-dup',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.duplicate, true);
  assert.equal(fetchCount, 0);
  assert.equal(applyCount, 0);
});

test('payment.created (pending) then payment.updated (approved) applies the approved event', async () => {
  const applied = new Set();
  const legacy = [];
  let fetchCount = 0;
  let applyCount = 0;
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    isAlreadyApplied: async ({ paymentId }) => applied.has(paymentId),
    markApplied: async ({ paymentId }) => {
      applied.add(paymentId);
    },
    markProcessed: async (doc) => {
      legacy.push(doc);
    },
    getPayment: async () => {
      fetchCount += 1;
      return fetchCount === 1
        ? { id: PAYMENT_ID, status: 'pending', external_reference: BOOKING_ID }
        : { id: PAYMENT_ID, status: 'approved', external_reference: BOOKING_ID };
    },
    applyApprovedPayment: async () => {
      applyCount += 1;
      return { applied: true };
    },
  });

  const pendingHeaders = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-pending',
    ts: nowSeconds(),
  });
  const first = await invoke(handler, {
    headers: pendingHeaders,
    body: { type: 'payment', action: 'payment.created', data: { id: PAYMENT_ID } },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.payload.applied, false);
  assert.equal(applied.has(PAYMENT_ID), false, 'pending must not be persisted');

  const approvedHeaders = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-approved',
    ts: nowSeconds(),
  });
  const second = await invoke(handler, {
    headers: approvedHeaders,
    body: { type: 'payment', action: 'payment.updated', data: { id: PAYMENT_ID } },
  });

  assert.equal(second.statusCode, 200);
  assert.equal(second.payload.applied, true);
  assert.equal(applied.has(PAYMENT_ID), true);
  assert.equal(applyCount, 1);
  assert.equal(legacy.length, 0, 'pending events must not be persisted as processed');
});

// ── Retryability ─────────────────────────────────────────────────────────────

test('an apply failure returns 5xx and the same event can be retried successfully', async () => {
  const applied = new Set();
  let applyCount = 0;
  let failFirst = true;
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    isAlreadyApplied: async ({ paymentId }) => applied.has(paymentId),
    markApplied: async ({ paymentId }) => {
      applied.add(paymentId);
    },
    markProcessed: async () => {},
    getPayment: async () => ({
      status: 'approved',
      external_reference: BOOKING_ID,
    }),
    applyApprovedPayment: async () => {
      if (failFirst) {
        failFirst = false;
        throw new Error('database unavailable');
      }
      applyCount += 1;
      return { applied: true };
    },
  });

  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-retry',
    ts: nowSeconds(),
  });
  const first = await invoke(handler, { headers, body: paymentBody() });
  assert.ok(first.statusCode >= 500, 'a failed apply must be retryable (5xx)');
  assert.equal(applied.has(PAYMENT_ID), false, 'no applied row may block the retry');

  const second = await invoke(handler, { headers, body: paymentBody() });
  assert.equal(second.statusCode, 200);
  assert.equal(second.payload.applied, true);
  assert.equal(applyCount, 1);
  assert.equal(applied.has(PAYMENT_ID), true);
});

test('a MercadoPago fetch failure returns 5xx and leaves no applied row', async () => {
  const { deps, applied } = createDeps({
    getPayment: async () => {
      const error = new Error('MP timeout');
      error.code = 'ECONNABORTED';
      throw error;
    },
  });
  const handler = createWebhookHandler(deps);
  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-fetch-fail',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.ok(res.statusCode >= 500);
  assert.equal(applied.has(PAYMENT_ID), false);
});

test('an approved payment the seam refuses to apply (ownership) is not persisted', async () => {
  const { deps, applied } = createDeps({
    applyApprovedPayment: async () => ({ applied: false, reason: 'not this club' }),
  });
  const handler = createWebhookHandler(deps);
  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-ownership',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.ok(res.statusCode >= 500);
  assert.equal(applied.has(PAYMENT_ID), false);
});

// ── Forgery ──────────────────────────────────────────────────────────────────

test('a forged signature is rejected and the booking is never touched', async () => {
  let appliedCount = 0;
  const { deps, applied, legacy } = createDeps({
    applyApprovedPayment: async () => {
      appliedCount += 1;
      return { applied: true };
    },
  });
  const handler = createWebhookHandler(deps);

  const headers = signHeaders({
    secret: 'forged-secret',
    paymentId: PAYMENT_ID,
    requestId: 'req-forged',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.equal(res.statusCode, 401);
  assert.equal(appliedCount, 0);
  assert.equal(applied.has(PAYMENT_ID), false);
  assert.equal(legacy.length, 0);
});

test('a payload-only companyId cannot forge an accepted event', async () => {
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: async () => {
      throw new SignatureError('No matching MercadoPago credential.');
    },
    isAlreadyApplied: async () => {
      assert.fail('must not check applied state for an unverified event');
    },
    markApplied: async () => {
      assert.fail('must not mark an unverified event as applied');
    },
    getPayment: async () => {
      assert.fail('must not fetch a payment for an unverified event');
    },
    applyApprovedPayment: async () => {
      assert.fail('must not apply an unverified event');
    },
  });

  const res = await invoke(handler, {
    headers: {},
    body: paymentBody({ companyId: 'attacker-company' }),
  });

  assert.equal(res.statusCode, 401);
});

test('a missing master key surfaces as 503, not as a 401 signature error', async () => {
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: async () => {
      throw new CryptoConfigError('PAYMENT_SECRET_KEY is not configured.');
    },
  });

  const res = await invoke(handler, { headers: {}, body: paymentBody() });

  assert.equal(res.statusCode, 503);
});

// ── Validation ───────────────────────────────────────────────────────────────

test('a request without a payment id is rejected with 400', async () => {
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: async () => {
      assert.fail('must not resolve a company without a payment id');
    },
  });

  const res = await invoke(handler, { headers: {}, body: { type: 'payment' } });

  assert.equal(res.statusCode, 400);
});

test('the manifest id comes from the query param and is lowercased', async () => {
  // Signed over the lowercased id, delivered uppercased in the query param.
  const rawId = 'AbC123';
  const normalized = rawId.toLowerCase();
  const headers = signHeaders({
    secret: SECRET,
    paymentId: normalized,
    requestId: 'req-query',
    ts: nowSeconds(),
  });

  const { deps, applied } = createDeps({
    resolveCompanyFromSignature: async ({ headers: h, paymentId }) => {
      verifyWebhookSignature({ headers: h, paymentId, secret: SECRET });
      return { companyId: COMPANY, credential: {} };
    },
  });
  const handler = createWebhookHandler(deps);

  const res = await invoke(handler, {
    headers,
    query: { 'data.id': rawId },
    body: { type: 'payment', action: 'payment.updated', data: { id: rawId } },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(applied.has(normalized), true);
});

test('a non-payment event is acknowledged but not persisted', async () => {
  const { deps, applied, legacy } = createDeps({
    getPayment: async () => {
      assert.fail('must not fetch a payment for a non-payment event');
    },
  });
  const handler = createWebhookHandler(deps);

  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-plan',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, {
    headers,
    body: { type: 'plan', data: { id: PAYMENT_ID } },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(applied.has(PAYMENT_ID), false);
  assert.equal(legacy.length, 0);
});

// ── Fail-closed seam + deployment dependency ─────────────────────────────────

test('a seam that does not confirm applied:true is fail-closed (undefined)', async () => {
  const { deps, applied } = createDeps({
    applyApprovedPayment: async () => undefined,
  });
  const handler = createWebhookHandler(deps);
  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-seam-undefined',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.equal(res.statusCode, 503);
  assert.equal(applied.has(PAYMENT_ID), false, 'no applied row without a confirmed transition');
});

test('a seam that returns an empty object is fail-closed', async () => {
  const { deps, applied } = createDeps({
    applyApprovedPayment: async () => ({}),
  });
  const handler = createWebhookHandler(deps);
  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-seam-empty',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.equal(res.statusCode, 503);
  assert.equal(applied.has(PAYMENT_ID), false);
});

test('an unavailable transition seam returns a specific retryable 503', async () => {
  const { deps, applied } = createDeps({
    applyApprovedPayment: async () => ({
      applied: false,
      reason: 'deposit_service_not_deployed',
    }),
  });
  const handler = createWebhookHandler(deps);
  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-seam-unwired',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'DEPOSIT_TRANSITION_UNAVAILABLE');
  assert.equal(applied.has(PAYMENT_ID), false);
});

test('the webhook never hands a projected credential to getPayment', async () => {
  const captured = {};
  const { deps } = createDeps({
    getPayment: async (args) => {
      captured.args = args;
      return { status: 'approved', external_reference: BOOKING_ID };
    },
  });
  const handler = createWebhookHandler(deps);
  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-no-projected-cred',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.equal(res.statusCode, 200);
  assert.equal(captured.args.companyId, COMPANY);
  assert.equal(captured.args.paymentId, PAYMENT_ID);
  assert.equal(
    captured.args.credential,
    undefined,
    'getPayment must load the full credential itself',
  );
});

// ── Slice-3 end-to-end seam ──────────────────────────────────────────────────

test('the default seam applies an approved deposit end-to-end (booking -> reservado)', async () => {
  const Booking = require('../models/booking.model');
  const { createInMemoryBookingModel } = require('./helpers/inMemoryBookingModel');
  const model = createInMemoryBookingModel([
    {
      _id: BOOKING_ID,
      companyId: COMPANY,
      status: 'pendiente_seña',
      finalPrice: 25000,
      deposit: {
        required: true,
        amount: 5000,
        status: 'pendiente',
        paymentId: null,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    },
  ]);
  // Persistence only; the real webhook handler + real deposit.service run.
  Booking.findOneAndUpdate = (filter, update, options) =>
    model.findOneAndUpdate(filter, update, options);

  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    isAlreadyApplied: async () => false,
    markApplied: async () => {},
    getPayment: async () => ({ status: 'approved', external_reference: BOOKING_ID }),
    // applyApprovedPayment is intentionally omitted -> default seam.
  });

  const res = await invoke(handler, {
    headers: signHeaders({
      secret: SECRET,
      paymentId: PAYMENT_ID,
      requestId: 'req-e2e-slice3',
      ts: nowSeconds(),
    }),
    body: paymentBody(),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.applied, true);
  assert.equal(model.bookings[0].status, 'reservado');
  assert.equal(model.bookings[0].deposit.status, 'pagado');
  assert.equal(model.bookings[0].finalPrice, 20000);
});

test('concurrent duplicates may both run the seam — Slice 3 approveDeposit must be idempotent', async () => {
  const applied = new Set();
  let seamCalls = 0;
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    isAlreadyApplied: async ({ paymentId }) => applied.has(paymentId),
    markApplied: async ({ paymentId }) => {
      if (applied.has(paymentId)) {
        const error = new Error('E11000 duplicate key');
        error.code = 11000;
        throw error;
      }
      applied.add(paymentId);
    },
    markProcessed: async () => {},
    getPayment: async () => ({ status: 'approved', external_reference: BOOKING_ID }),
    applyApprovedPayment: async () => {
      seamCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { applied: true };
    },
  });

  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-concurrent',
    ts: nowSeconds(),
  });
  const [first, second] = await Promise.all([
    invoke(handler, { headers, body: paymentBody() }),
    invoke(handler, { headers, body: paymentBody() }),
  ]);

  // Documents the double-apply window: the seam is invoked twice because the
  // applied row is only written afterwards. Slice 3's approveDeposit MUST be
  // idempotent/atomic to make this safe.
  assert.equal(seamCalls, 2);
  assert.deepEqual([first.statusCode, second.statusCode], [200, 200]);
  const payloads = [first.payload, second.payload];
  assert.ok(payloads.some((p) => p.applied === true));
  assert.ok(payloads.some((p) => p.duplicate === true));
});

// ── Rate limit ───────────────────────────────────────────────────────────────

test('the webhook rate limiter returns 429 after the configured burst', () => {
  assert.ok(Number.isInteger(WEBHOOK_RATE_LIMIT_MAX) && WEBHOOK_RATE_LIMIT_MAX > 0);
  const ip = '198.51.100.42';
  let passed = 0;
  for (let i = 0; i < WEBHOOK_RATE_LIMIT_MAX; i += 1) {
    webhookRateLimiter({ ip }, createResponse(), () => {
      passed += 1;
    });
  }
  assert.equal(passed, WEBHOOK_RATE_LIMIT_MAX);

  const blocked = createResponse();
  let extraPassed = false;
  webhookRateLimiter({ ip }, blocked, () => {
    extraPassed = true;
  });
  assert.equal(blocked.statusCode, 429);
  assert.equal(extraPassed, false);
});

// ── Router / app wiring ──────────────────────────────────────────────────────

test('createWebhookRouter mounts the rate limiter then a POST / handler', () => {
  const router = createWebhookRouter();
  assert.equal(router.isMercadoPagoWebhook, true);
  const route = router.stack.find((layer) => layer.route && layer.route.methods.post);
  assert.ok(route, 'missing POST / webhook route');
  assert.equal(route.route.stack[0].handle, webhookRateLimiter);
});

test('app.js mounts the webhook raw body before the global JSON parser', () => {
  const app = require('../app');
  const stack = (app.router || app._router).stack;

  const jsonIndex = stack.findIndex((layer) => layer.name === 'jsonParser');
  const rawIndex = stack.findIndex((layer) => layer.name === 'rawParser');
  const webhookIndex = stack.findIndex(
    (layer) =>
      layer.handle &&
      (layer.handle.isMercadoPagoWebhook ||
        (layer.handle.handle && layer.handle.handle.isMercadoPagoWebhook)),
  );

  assert.ok(jsonIndex >= 0, 'global JSON parser not found');
  assert.ok(rawIndex >= 0, 'raw webhook parser not found');
  assert.ok(webhookIndex >= 0, 'webhook router not found');
  assert.ok(rawIndex < jsonIndex, 'raw body parser must run before express.json()');
  assert.ok(webhookIndex < jsonIndex, 'webhook route must be before express.json()');
});

'use strict';

// Integration tests for the MercadoPago webhook handler using in-memory fakes
// for the durable idempotency gate and the booking-transition seam:
// - signed `payment.approved` reaches the transition seam
// - duplicate payment ids are ignored (ProcessedWebhook unique index)
// - forged signatures are rejected and never touch the booking
// - the company is derived from the credential, never the payload
// Also asserts the raw-body mount happens before the global JSON parser.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-webhook';

const ProcessedWebhook = require('../models/processedWebhook.model');
const { SignatureError, verifyWebhookSignature } = require('../services/mercadopago.service');
const { createWebhookHandler, createWebhookRouter } = require('../routes/webhook.routes');

const COMPANY = '64b0000000000000000000a1';
const BOOKING_ID = '64b0000000000000000000c3';
const PAYMENT_ID = 'pay-777';
const SECRET = 'club-webhook-secret';

const nowSeconds = () => String(Math.floor(Date.now() / 1000));

const signHeaders = ({ secret, paymentId, requestId, ts }) => {
  const manifest = `id:${paymentId};request-id:${requestId};ts:${ts};`;
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

const invoke = async (handler, { headers = {}, body = {} }) => {
  const res = createResponse();
  await handler({ headers, body: Buffer.from(JSON.stringify(body)) }, res);
  return res;
};

const paymentBody = (extra = {}) => ({
  type: 'payment',
  action: 'payment.created',
  data: { id: PAYMENT_ID },
  ...extra,
});

// ── Model ────────────────────────────────────────────────────────────────────

test('ProcessedWebhook defines a unique provider+paymentId index', () => {
  const indexes = ProcessedWebhook.schema.indexes();
  const unique = indexes.find(
    ([definition, options]) =>
      definition.provider === 1 &&
      definition.paymentId === 1 &&
      options?.unique === true,
  );
  assert.ok(unique, 'missing unique (provider, paymentId) index');
});

// ── Approval flow ────────────────────────────────────────────────────────────

test('a signed approval reaches the transition seam with the credential company', async () => {
  const marked = [];
  const applied = [];
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    markProcessed: async (doc) => {
      marked.push(doc);
    },
    getPayment: async () => ({
      id: PAYMENT_ID,
      status: 'approved',
      external_reference: BOOKING_ID,
    }),
    applyApprovedPayment: async (payload) => {
      applied.push(payload);
    },
  });

  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-appr',
    ts: nowSeconds(),
  });
  // A malicious body-supplied companyId must be ignored.
  const res = await invoke(handler, {
    headers,
    body: paymentBody({ companyId: 'attacker-company' }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(marked.length, 1);
  assert.equal(String(marked[0].companyId), COMPANY);
  assert.equal(marked[0].paymentId, PAYMENT_ID);
  assert.equal(applied.length, 1);
  assert.equal(String(applied[0].companyId), COMPANY);
  assert.equal(applied[0].bookingId, BOOKING_ID);
  assert.equal(applied[0].paymentId, PAYMENT_ID);
  assert.equal(applied[0].eventType, 'payment.approved');
});

test('a duplicate payment id is ignored without re-applying the transition', async () => {
  let appliedCount = 0;
  let fetchCount = 0;
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    markProcessed: async () => {
      const error = new Error('E11000 duplicate key');
      error.code = 11000;
      throw error;
    },
    getPayment: async () => {
      fetchCount += 1;
      return { status: 'approved', external_reference: BOOKING_ID };
    },
    applyApprovedPayment: async () => {
      appliedCount += 1;
    },
  });

  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-dup',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.duplicate, true);
  assert.equal(appliedCount, 0);
  assert.equal(fetchCount, 0);
});

// ── Forgery ──────────────────────────────────────────────────────────────────

test('a forged signature is rejected and the booking is never touched', async () => {
  let appliedCount = 0;
  let markedCount = 0;
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    markProcessed: async () => {
      markedCount += 1;
    },
    getPayment: async () => ({ status: 'approved', external_reference: BOOKING_ID }),
    applyApprovedPayment: async () => {
      appliedCount += 1;
    },
  });

  const headers = signHeaders({
    secret: 'forged-secret',
    paymentId: PAYMENT_ID,
    requestId: 'req-forged',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.equal(res.statusCode, 401);
  assert.equal(appliedCount, 0);
  assert.equal(markedCount, 0);
});

test('a payload-only companyId cannot forge an accepted event', async () => {
  // No resolver override: use the real service against an empty credential
  // store, so a body-supplied companyId cannot satisfy verification.
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: async () => {
      throw new SignatureError('No matching MercadoPago credential.');
    },
    markProcessed: async () => {
      assert.fail('must not mark an unverified event as processed');
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

// ── Validation ───────────────────────────────────────────────────────────────

test('a body without a payment id is rejected with 400', async () => {
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: async () => {
      assert.fail('must not resolve a company without a payment id');
    },
  });

  const res = await invoke(handler, { headers: {}, body: { type: 'payment' } });

  assert.equal(res.statusCode, 400);
});

test('a signed but non-approved payment is recorded without applying the transition', async () => {
  const marked = [];
  let appliedCount = 0;
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    markProcessed: async (doc) => {
      marked.push(doc);
    },
    getPayment: async () => ({
      id: PAYMENT_ID,
      status: 'pending',
      external_reference: BOOKING_ID,
    }),
    applyApprovedPayment: async () => {
      appliedCount += 1;
    },
  });

  const headers = signHeaders({
    secret: SECRET,
    paymentId: PAYMENT_ID,
    requestId: 'req-pending',
    ts: nowSeconds(),
  });
  const res = await invoke(handler, { headers, body: paymentBody() });

  assert.equal(res.statusCode, 200);
  assert.equal(marked.length, 1);
  assert.equal(appliedCount, 0);
});

test('non-payment events are recorded but the transition seam is not called', async () => {
  const marked = [];
  let appliedCount = 0;
  const handler = createWebhookHandler({
    resolveCompanyFromSignature: makeResolver(SECRET, COMPANY),
    markProcessed: async (doc) => {
      marked.push(doc);
    },
    getPayment: async () => {
      assert.fail('must not fetch a payment for a non-payment event');
    },
    applyApprovedPayment: async () => {
      appliedCount += 1;
    },
  });

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
  assert.equal(marked.length, 1);
  assert.equal(marked[0].eventType, 'plan');
  assert.equal(appliedCount, 0);
});

// ── Router / app wiring ──────────────────────────────────────────────────────

test('createWebhookRouter mounts a POST / handler marked as the raw-body webhook', () => {
  const router = createWebhookRouter();
  assert.equal(router.isMercadoPagoWebhook, true);
  const route = router.stack.find((layer) => layer.route && layer.route.methods.post);
  assert.ok(route, 'missing POST / webhook route');
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
  assert.ok(
    rawIndex < jsonIndex,
    'raw body parser must run before express.json()',
  );
  assert.ok(
    webhookIndex < jsonIndex,
    'webhook route must be mounted before express.json()',
  );
});

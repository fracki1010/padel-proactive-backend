'use strict';

// Public MercadoPago webhook: POST /webhooks/mercadopago
// Mounted in app.js BEFORE express.json() with express.raw so the request body
// stays untouched (see the app.js comment for the accurate rationale). The
// signature manifest covers id/request-id/ts, not the raw bytes.
//
// Flow (review-corrected):
//   1. verify the x-signature HMAC and derive the company from the matched
//      credential, using the MP account id (if present) only as a lookup hint
//   2. non-payment events are acknowledged without persisting
//   3. only an APPLIED terminal transition is persisted; pending/created events
//      are answered 200 so a later `approved` for the same payment still applies
//   4. fetch/apply failures return 503 so MercadoPago RETRIES; no row is left
//      behind that could block the retry, so an approved payment is not lost

const express = require('express');

const ProcessedWebhook = require('../models/processedWebhook.model');
const { CryptoConfigError } = require('../lib/crypto');
const { createRateLimiter } = require('../middleware/rateLimit.middleware');
const {
  SignatureError,
  WEBHOOK_PROVIDER,
  getPayment,
  normalizeManifestId,
  resolveCompanyFromSignature,
} = require('../services/mercadopago.service');

const PAYMENT_EVENT_TYPE = 'payment';
const APPLIED_STATUS = 'applied';

const WEBHOOK_RATE_LIMIT_WINDOW_MS = Number(
  process.env.MP_WEBHOOK_RATE_LIMIT_WINDOW_MS || 60_000,
);
const WEBHOOK_RATE_LIMIT_MAX = Number(process.env.MP_WEBHOOK_RATE_LIMIT_MAX || 120);
const webhookRateLimiter = createRateLimiter({
  windowMs: WEBHOOK_RATE_LIMIT_WINDOW_MS,
  maxRequests: WEBHOOK_RATE_LIMIT_MAX,
});

// Booking transition seam. Slice 3 wires `deposit.service.approveDeposit` to
// move the booking to `reservado` + `deposit.status=pagado` atomically. When the
// seam is not wired it reports `applied:false`, so the handler returns 503 and
// MercadoPago retries; the approved payment is therefore not lost.
const defaultApplyApprovedPayment = async ({ companyId, bookingId, paymentId }) => {
  let depositService = null;
  try {
    depositService = require('../services/deposit.service');
  } catch {
    depositService = null;
  }

  if (depositService && typeof depositService.approveDeposit === 'function') {
    return depositService.approveDeposit({
      companyId,
      bookingId,
      paymentId,
      eventType: 'payment.approved',
    });
  }

  console.warn(
    `[mercadopago-webhook] booking transition seam not wired (Slice 3): booking=${bookingId} payment=${paymentId}`,
  );
  return { applied: false, reason: 'deposit service not wired' };
};

const parseRawBody = (body) => {
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8').trim();
    return text ? JSON.parse(text) : {};
  }
  if (typeof body === 'string') {
    const text = body.trim();
    return text ? JSON.parse(text) : {};
  }
  return body && typeof body === 'object' ? body : {};
};

// MP spec: the manifest id is the query param `data.id` (or `id`). The body
// `data.id` is a fallback; the notification id (`body.id`) is NOT valid.
const extractPaymentId = (req, body) => {
  const query = req?.query || {};
  const raw = query['data.id'] ?? query.id ?? body?.data?.id;
  return normalizeManifestId(raw);
};

const extractEventType = (body) =>
  String(body?.type || body?.topic || '').trim().toLowerCase();

const extractMpUserId = (body) => {
  const value = body?.user_id;
  return value === undefined || value === null || value === ''
    ? null
    : String(value);
};

const createWebhookHandler = (dependencies = {}) => {
  const model = dependencies.processedWebhookModel || ProcessedWebhook;
  const resolveCompany =
    dependencies.resolveCompanyFromSignature || resolveCompanyFromSignature;
  const isAlreadyApplied =
    dependencies.isAlreadyApplied ||
    (async ({ paymentId }) =>
      Boolean(
        await model.findOne({
          provider: WEBHOOK_PROVIDER,
          paymentId,
          status: APPLIED_STATUS,
        }),
      ));
  const markApplied =
    dependencies.markApplied || ((document) => model.create(document));
  const fetchPayment = dependencies.getPayment || getPayment;
  const applyApprovedPayment =
    dependencies.applyApprovedPayment || defaultApplyApprovedPayment;
  const credentialModel = dependencies.credentialModel;

  return async (req, res) => {
    let body;
    try {
      body = parseRawBody(req.body);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid JSON body' });
    }

    const paymentId = extractPaymentId(req, body);
    if (!paymentId) {
      return res.status(400).json({ success: false, error: 'Missing payment id' });
    }
    const eventType = extractEventType(body);
    const mpUserId = extractMpUserId(body);

    let match;
    try {
      match = await resolveCompany({
        headers: req.headers || {},
        paymentId,
        mpUserId,
        credentialModel,
      });
    } catch (error) {
      if (error instanceof CryptoConfigError) {
        return res.status(503).json({
          success: false,
          error: 'Payment encryption is not configured.',
        });
      }
      if (error instanceof SignatureError) {
        return res.status(401).json({ success: false, error: 'Invalid signature' });
      }
      throw error;
    }

    const { companyId } = match;

    // Only a payment event can produce an applied terminal transition.
    if (eventType !== PAYMENT_EVENT_TYPE) {
      return res.status(200).json({ success: true, ignored: true });
    }

    // Applied-only idempotency gate: only a prior *applied* row dedupes.
    let alreadyApplied;
    try {
      alreadyApplied = await isAlreadyApplied({ paymentId, companyId, credentialModel });
    } catch (error) {
      console.error('[mercadopago-webhook] idempotency lookup failed:', error?.message);
      return res.status(503).json({ success: false, error: 'Temporary failure' });
    }
    if (alreadyApplied) {
      return res.status(200).json({ success: true, duplicate: true });
    }

    let payment;
    try {
      payment = await fetchPayment({
        companyId,
        paymentId,
        credential: match.credential,
      });
    } catch (error) {
      // Retryable: no row is persisted, so MP will resend and we try again.
      console.error('[mercadopago-webhook] payment fetch failed:', error?.message);
      return res.status(503).json({ success: false, error: 'Temporary failure' });
    }

    if (!payment || payment.status !== 'approved') {
      // Non-terminal (or terminal-but-not-approved): acknowledge without
      // persisting so a later `approved` for the same id still applies.
      return res.status(200).json({
        success: true,
        applied: false,
        status: payment?.status || 'unknown',
      });
    }

    const bookingId = String(payment.external_reference || '');
    if (!bookingId) {
      // An approved payment without a booking reference is not our deposit.
      return res.status(200).json({
        success: true,
        applied: false,
        reason: 'no_booking_reference',
      });
    }

    let result;
    try {
      result = await applyApprovedPayment({
        companyId,
        bookingId,
        paymentId,
        eventType: 'payment.approved',
      });
    } catch (error) {
      console.error('[mercadopago-webhook] transition failed:', error?.message);
      return res.status(503).json({ success: false, error: 'Temporary failure' });
    }

    // `applied:false` means the seam did not commit the transition (not wired
    // yet, or the booking is not owned by the matched company). Do not persist,
    // so MP retries and a real approved payment is never lost.
    if (result && result.applied === false) {
      return res.status(503).json({ success: false, error: 'Transition not applied' });
    }

    try {
      await markApplied({
        provider: WEBHOOK_PROVIDER,
        paymentId,
        companyId,
        eventType: 'payment.approved',
        status: APPLIED_STATUS,
        receivedAt: new Date(),
      });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(200).json({ success: true, duplicate: true });
      }
      console.error('[mercadopago-webhook] failed to persist applied row:', error?.message);
      return res.status(503).json({ success: false, error: 'Temporary failure' });
    }

    return res.status(200).json({ success: true, applied: true });
  };
};

const createWebhookRouter = (dependencies = {}) => {
  const router = express.Router();
  router.isMercadoPagoWebhook = true;
  router.post('/', webhookRateLimiter, createWebhookHandler(dependencies));
  return router;
};

const router = createWebhookRouter();

module.exports = router;
module.exports.createWebhookHandler = createWebhookHandler;
module.exports.createWebhookRouter = createWebhookRouter;
module.exports.defaultApplyApprovedPayment = defaultApplyApprovedPayment;
module.exports.webhookRateLimiter = webhookRateLimiter;
module.exports.WEBHOOK_RATE_LIMIT_MAX = WEBHOOK_RATE_LIMIT_MAX;
module.exports.WEBHOOK_RATE_LIMIT_WINDOW_MS = WEBHOOK_RATE_LIMIT_WINDOW_MS;

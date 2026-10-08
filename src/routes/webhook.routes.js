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
// move the booking to `reservado` + `deposit.status=pagado` atomically.
//
// DEPLOYMENT ORDER (mandatory): if `services/deposit.service` is not deployed,
// the seam returns `{applied:false}` -> the handler responds 503 and MercadoPago
// retries. Retries are finite, so Slice 2 MUST be deployed together with (or
// after) Slice 3's `approveDeposit`; otherwise approved deposits are eventually
// lost. A startup warning is emitted when the service is absent.
const DEPOSIT_SERVICE_MODULE = '../services/deposit.service';
const depositServiceAvailable = (() => {
  try {
    require.resolve(DEPOSIT_SERVICE_MODULE);
    return true;
  } catch {
    return false;
  }
})();
if (!depositServiceAvailable) {
  console.warn(
    '[mercadopago-webhook] deposit.service (Slice 3) is NOT deployed. Approved ' +
      'payments will return 503 and be retried by MercadoPago until it is. Deploy ' +
      'Slice 2 together with, or after, Slice 3.',
  );
}

const defaultApplyApprovedPayment = async ({
  companyId,
  bookingId,
  paymentId,
  amount = null,
}) => {
  let depositService = null;
  try {
    depositService = require(DEPOSIT_SERVICE_MODULE);
  } catch {
    depositService = null;
  }

  if (depositService && typeof depositService.approveDeposit === 'function') {
    // Amount guard: the captured amount must match the configured seña. A
    // mismatch is NOT silently confirmed — it is flagged for manual review and
    // acked so MercadoPago stops retrying.
    if (amount !== null && amount !== undefined && typeof depositService.getBookingForDeposit === 'function') {
      const current = await depositService.getBookingForDeposit({ companyId, bookingId });
      const expected = current?.deposit?.amount;
      if (
        current &&
        expected !== null &&
        expected !== undefined &&
        Number(amount) !== Number(expected)
      ) {
        await depositService.handleAmountMismatch({
          companyId,
          bookingId,
          paymentId,
          booking: current,
          expected,
          received: amount,
        });
        return { applied: true, reason: 'amount_mismatch', mismatch: true, booking: current };
      }
    }

    const result = await depositService.approveDeposit({
      companyId,
      bookingId,
      paymentId,
      eventType: 'payment.approved',
    });

    if (result?.applied === true) {
      // Confirm the client + alert the admin, best-effort. The transition is
      // already durable, so a notification failure must not undo it.
      await depositService.handleDepositPaid({
        companyId,
        booking: result.booking,
        paymentId,
      });
      return result;
    }

    // The booking was not pending. Distinguish an idempotent retry (already
    // paid) from a LATE payment (hold expired/cancelled after the capture).
    const current =
      typeof depositService.getBookingForDeposit === 'function'
        ? await depositService.getBookingForDeposit({ companyId, bookingId })
        : null;

    if (
      current &&
      current.status === 'reservado' &&
      String(current.deposit?.paymentId || '') === String(paymentId)
    ) {
      // WARNING 4: if a previous attempt approved but failed to persist the
      // applied row, this retry must still succeed so the row can be written.
      return { applied: true, reason: 'already_applied', booking: current };
    }

    // BLOCKER 1: money captured after the hold died. Do NOT re-book the court;
    // alert admins for manual review/refund, and ack so MP stops retrying.
    await depositService.handleLatePayment({
      companyId,
      bookingId,
      paymentId,
      booking: current || null,
    });
    return { applied: true, reason: 'late_payment', late: true, booking: current || null };
  }

  console.warn(
    `[mercadopago-webhook] booking transition seam not wired (Slice 3): booking=${bookingId} payment=${paymentId}`,
  );
  return { applied: false, reason: 'deposit_service_not_deployed' };
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
      // Do NOT pass `match.credential`: it is the projected webhook candidate,
      // which excludes the access token. getPayment loads the full credential
      // by companyId itself.
      payment = await fetchPayment({ companyId, paymentId });
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
        amount: payment?.transaction_amount ?? null,
        eventType: 'payment.approved',
      });
    } catch (error) {
      console.error('[mercadopago-webhook] transition failed:', error?.message);
      return res.status(503).json({ success: false, error: 'Temporary failure' });
    }

    // Fail-closed: persist an applied row ONLY when the seam explicitly confirms
    // the transition (`result.applied === true`). `undefined`/`{}`/`true` mean
    // no confirmed commit; return 503 so MP retries and no row blocks the retry.
    if (!result || result.applied !== true) {
      return res.status(503).json({
        success: false,
        error: 'Deposit transition service is not available yet.',
        code: 'DEPOSIT_TRANSITION_UNAVAILABLE',
        reason: result?.reason || 'transition_not_confirmed',
      });
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

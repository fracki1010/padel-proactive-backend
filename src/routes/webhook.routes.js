'use strict';

// Public MercadoPago webhook: POST /webhooks/mercadopago
// Mounted in app.js BEFORE express.json() with express.raw so the request body
// stays untouched. Flow:
//   1. verify the x-signature HMAC against each active club credential and
//      derive the company from the matched credential (never the payload)
//   2. record the payment id in ProcessedWebhook; E11000 => already processed
//   3. for payment events, fetch the payment with the club token and, when
//      approved, run the booking transition seam.

const express = require('express');

const ProcessedWebhook = require('../models/processedWebhook.model');
const {
  SignatureError,
  WEBHOOK_PROVIDER,
  getPayment,
  resolveCompanyFromSignature,
} = require('../services/mercadopago.service');

const PAYMENT_EVENT_TYPE = 'payment';

// Booking transition seam. Slice 3 wires `deposit.service.approveDeposit` to
// move the booking to `reservado` + `deposit.status=pagado` atomically. Until
// then the event is still durably recorded, so no approved payment is lost;
// the transition is a logged no-op. See apply-progress for the dependency.
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

const extractPaymentId = (body) => {
  const raw = body?.data?.id ?? body?.data_id ?? body?.id;
  return raw === undefined || raw === null || raw === '' ? null : String(raw);
};

const extractEventType = (body) =>
  String(body?.type || body?.topic || '').trim().toLowerCase();

const createWebhookHandler = (dependencies = {}) => {
  const resolveCompany =
    dependencies.resolveCompanyFromSignature || resolveCompanyFromSignature;
  const markProcessed =
    dependencies.markProcessed ||
    ((document) => ProcessedWebhook.create(document));
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

    const paymentId = extractPaymentId(body);
    if (!paymentId) {
      return res.status(400).json({ success: false, error: 'Missing payment id' });
    }
    const eventType = extractEventType(body);

    let match;
    try {
      match = await resolveCompany({
        headers: req.headers || {},
        paymentId,
        credentialModel,
      });
    } catch (error) {
      if (error instanceof SignatureError) {
        return res.status(401).json({ success: false, error: 'Invalid signature' });
      }
      throw error;
    }

    const { companyId } = match;

    try {
      await markProcessed({
        provider: WEBHOOK_PROVIDER,
        paymentId,
        companyId,
        eventType,
        receivedAt: new Date(),
      });
    } catch (error) {
      if (error && error.code === 11000) {
        return res.status(200).json({ success: true, duplicate: true });
      }
      throw error;
    }

    if (eventType === PAYMENT_EVENT_TYPE) {
      try {
        const payment = await fetchPayment({
          companyId,
          paymentId,
          credential: match.credential,
        });
        if (payment && payment.status === 'approved') {
          await applyApprovedPayment({
            companyId,
            bookingId: String(payment.external_reference || ''),
            paymentId,
            eventType: 'payment.approved',
          });
        }
      } catch (error) {
        // The event is already recorded, so it will not be retried by MP.
        // Log loudly for ops; responding 200 prevents MP retry storms.
        console.error(
          '[mercadopago-webhook] failed to apply payment:',
          error?.message,
        );
      }
    }

    return res.status(200).json({ success: true });
  };
};

const createWebhookRouter = (dependencies = {}) => {
  const router = express.Router();
  router.isMercadoPagoWebhook = true;
  router.post('/', createWebhookHandler(dependencies));
  return router;
};

const router = createWebhookRouter();

module.exports = router;
module.exports.createWebhookHandler = createWebhookHandler;
module.exports.createWebhookRouter = createWebhookRouter;
module.exports.defaultApplyApprovedPayment = defaultApplyApprovedPayment;

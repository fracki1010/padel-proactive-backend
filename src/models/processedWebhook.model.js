'use strict';

// Durable idempotency gate for payment webhooks. The unique
// (provider, paymentId) index is the first line of defense: the first event for
// a payment id wins and any resend hits an E11000 duplicate key error. The
// booking-level status guard (applied by the transition seam) is the second.

const mongoose = require('mongoose');

const PROCESSED_WEBHOOK_PROVIDERS = ['mercadopago'];

const processedWebhookSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: PROCESSED_WEBHOOK_PROVIDERS,
      default: 'mercadopago',
      required: true,
    },
    paymentId: {
      type: String,
      required: true,
      trim: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
    },
    eventType: {
      type: String,
      default: '',
      trim: true,
    },
    receivedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

processedWebhookSchema.index({ provider: 1, paymentId: 1 }, { unique: true });

module.exports = mongoose.model('ProcessedWebhook', processedWebhookSchema);
module.exports.PROCESSED_WEBHOOK_PROVIDERS = PROCESSED_WEBHOOK_PROVIDERS;

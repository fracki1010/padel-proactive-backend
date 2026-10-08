'use strict';

// Durable idempotency gate for payment webhooks. It records APPLIED terminal
// transitions only: the row is written after a successful, ownership-scoped
// apply, and only a `status: "applied"` row dedupes a retry. The unique
// (provider, paymentId) index makes a concurrent duplicate collide with E11000.

const mongoose = require('mongoose');

const PROCESSED_WEBHOOK_PROVIDERS = ['mercadopago'];
const PROCESSED_WEBHOOK_STATUSES = ['pending', 'applied', 'failed'];

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
    // Only `applied` records block a retry; `pending`/`failed` must not.
    status: {
      type: String,
      enum: PROCESSED_WEBHOOK_STATUSES,
      default: 'applied',
      required: true,
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
module.exports.PROCESSED_WEBHOOK_STATUSES = PROCESSED_WEBHOOK_STATUSES;

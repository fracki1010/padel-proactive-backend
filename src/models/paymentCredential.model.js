'use strict';

// Per-company payment provider credentials. Secrets are stored encrypted at
// rest (AES-256-GCM via src/lib/crypto.js); this model never persists or
// serializes plaintext. `toJSON` strips every secret field so an accidental
// `res.json(credential)` cannot leak the token.

const mongoose = require('mongoose');

const PAYMENT_PROVIDERS = ['mercadopago'];

const paymentCredentialSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
      required: true,
    },
    provider: {
      type: String,
      enum: PAYMENT_PROVIDERS,
      default: 'mercadopago',
      required: true,
    },
    tokenCiphertext: {
      type: String,
      required: true,
    },
    iv: {
      type: String,
      required: true,
    },
    authTag: {
      type: String,
      required: true,
    },
    keyVersion: {
      type: String,
      default: 'v1',
    },
    webhookSecretCiphertext: {
      type: String,
      default: '',
    },
    webhookSecretIv: {
      type: String,
      default: '',
    },
    webhookSecretAuthTag: {
      type: String,
      default: '',
    },
    mpUserId: {
      type: String,
      default: '',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        delete ret.tokenCiphertext;
        delete ret.iv;
        delete ret.authTag;
        delete ret.keyVersion;
        delete ret.webhookSecretCiphertext;
        delete ret.webhookSecretIv;
        delete ret.webhookSecretAuthTag;
        return ret;
      },
    },
  },
);

paymentCredentialSchema.index({ companyId: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('PaymentCredential', paymentCredentialSchema);
module.exports.PAYMENT_PROVIDERS = PAYMENT_PROVIDERS;

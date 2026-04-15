const mongoose = require("mongoose");

const whatsappRuntimeStateSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      default: "disabled",
      trim: true,
    },
    qr: {
      type: String,
      default: null,
    },
    hasQr: {
      type: Boolean,
      default: false,
    },
    loadingPercent: {
      type: Number,
      default: null,
    },
    loadingMessage: {
      type: String,
      default: null,
      trim: true,
    },
    lastQrAt: {
      type: String,
      default: null,
      trim: true,
    },
    authenticatedAt: {
      type: String,
      default: null,
      trim: true,
    },
    readyAt: {
      type: String,
      default: null,
      trim: true,
    },
    authFailure: {
      type: String,
      default: null,
      trim: true,
    },
    lastError: {
      type: String,
      default: null,
      trim: true,
    },
    lastDisconnectReason: {
      type: String,
      default: null,
      trim: true,
    },
    startingAt: {
      type: String,
      default: null,
      trim: true,
    },
    stoppedAt: {
      type: String,
      default: null,
      trim: true,
    },
    reconnectAttempts: {
      type: Number,
      default: 0,
    },
    updatedAtIso: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

whatsappRuntimeStateSchema.index({ companyId: 1 }, { unique: true });

module.exports = mongoose.model(
  "WhatsappRuntimeState",
  whatsappRuntimeStateSchema,
);

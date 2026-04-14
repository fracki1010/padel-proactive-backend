const mongoose = require("mongoose");

const appConfigSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    key: {
      type: String,
      required: true,
      default: "main",
    },
    whatsappEnabled: {
      type: Boolean,
      default: false,
    },
    oneHourReminderEnabled: {
      type: Boolean,
      default: true,
    },
    attendanceReminderLeadMinutes: {
      type: Number,
      default: 60,
      min: 5,
      max: 240,
    },
    trustedClientConfirmationCount: {
      type: Number,
      default: 3,
      min: 1,
      max: 20,
    },
    penaltyLimit: {
      type: Number,
      default: 2,
      min: 1,
    },
    penaltySystemEnabled: {
      type: Boolean,
      default: true,
    },
    cancellationGroupEnabled: {
      type: Boolean,
      default: false,
    },
    cancellationGroupId: {
      type: String,
      default: "",
      trim: true,
    },
    cancellationGroupName: {
      type: String,
      default: "",
      trim: true,
    },
    cancellationLockHours: {
      type: Number,
      default: 2,
      min: 0,
      max: 72,
    },
    dailyAvailabilityDigestEnabled: {
      type: Boolean,
      default: false,
    },
    dailyAvailabilityDigestLastSentDate: {
      type: String,
      default: "",
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

appConfigSchema.index({ companyId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("AppConfig", appConfigSchema);

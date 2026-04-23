const mongoose = require("mongoose");

const otpVerificationSchema = new mongoose.Schema({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Company",
    required: true,
  },
  phone: {
    type: String,
    required: true,
  },
  code: {
    type: String,
    required: true,
  },
  used: {
    type: Boolean,
    default: false,
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }, // MongoDB TTL: elimina el doc cuando expiresAt pase
  },
});

otpVerificationSchema.index({ companyId: 1, phone: 1 });

module.exports = mongoose.model("OtpVerification", otpVerificationSchema);

const mongoose = require("mongoose");

const clientAccountSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      default: "",
      trim: true,
    },
    passwordHash: {
      type: String,
      default: "",
    },
    googleAuth: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    linkedUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

// Solo indexa documentos con email no vacío; permite múltiples cuentas sin email
// (Google/WhatsApp) sin romper el índice único.
clientAccountSchema.index(
  { companyId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $gt: "" } } },
);
// Solo indexa documentos con phone no vacío; permite múltiples cuentas sin teléfono
clientAccountSchema.index(
  { companyId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $gt: "" } } },
);

module.exports = mongoose.model("ClientAccount", clientAccountSchema);

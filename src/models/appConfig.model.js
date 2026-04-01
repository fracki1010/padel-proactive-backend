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
  },
  {
    timestamps: true,
  },
);

appConfigSchema.index({ companyId: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("AppConfig", appConfigSchema);

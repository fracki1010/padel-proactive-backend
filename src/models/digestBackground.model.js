const mongoose = require("mongoose");

const digestBackgroundSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    data: {
      type: Buffer,
      required: true,
    },
    mimeType: {
      type: String,
      required: true,
      enum: ["image/jpeg", "image/png", "image/webp"],
    },
    order: {
      type: Number,
      required: true,
      min: 1,
      max: 6,
    },
  },
  { timestamps: true },
);

digestBackgroundSchema.index({ companyId: 1, order: 1 }, { unique: true });

module.exports = mongoose.model("DigestBackground", digestBackgroundSchema);

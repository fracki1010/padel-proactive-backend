const mongoose = require("mongoose");

const companyImageSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    type: {
      type: String,
      required: true,
      enum: ["portal_cover", "digest_background"],
    },
    cloudinaryPublicId: {
      type: String,
      required: true,
    },
    url: {
      type: String,
      required: true,
    },
    order: {
      type: Number,
      default: 1,
      min: 1,
      max: 6,
    },
  },
  { timestamps: true },
);

companyImageSchema.index({ companyId: 1, type: 1, order: 1 }, { unique: true });

module.exports = mongoose.model("CompanyImage", companyImageSchema);

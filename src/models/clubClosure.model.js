const mongoose = require("mongoose");

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const clubClosureSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
      index: true,
    },
    startDate: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (v) => ISO_DATE_REGEX.test(v),
        message: "startDate debe tener formato YYYY-MM-DD.",
      },
    },
    endDate: {
      type: String,
      required: true,
      trim: true,
      validate: {
        validator: (v) => ISO_DATE_REGEX.test(v),
        message: "endDate debe tener formato YYYY-MM-DD.",
      },
    },
    reason: {
      type: String,
      default: "",
      trim: true,
    },
  },
  { timestamps: true },
);

clubClosureSchema.index({ companyId: 1, startDate: 1, endDate: 1 });

module.exports = mongoose.model("ClubClosure", clubClosureSchema);

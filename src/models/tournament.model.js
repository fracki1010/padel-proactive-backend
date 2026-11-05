const mongoose = require("mongoose");

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const isValidDate = (value) => ISO_DATE_REGEX.test(value);

const tournamentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    // Date-only YYYY-MM-DD strings: inclusive comparison keeps zone drift out.
    startDate: {
      type: String,
      required: true,
      trim: true,
      validate: { validator: isValidDate, message: "startDate debe usar el formato YYYY-MM-DD." },
    },
    endDate: {
      type: String,
      required: true,
      trim: true,
      validate: [
        { validator: isValidDate, message: "endDate debe usar el formato YYYY-MM-DD." },
        {
          validator(value) {
            return !this.startDate || value >= this.startDate;
          },
          message: "endDate debe ser igual o posterior a startDate.",
        },
      ],
    },
    status: {
      type: String,
      enum: ["draft", "in_progress", "finished", "cancelled"],
      default: "draft",
    },
    courts: [{ type: mongoose.Schema.Types.ObjectId, ref: "Court" }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    activatedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

tournamentSchema.index({ companyId: 1, status: 1, startDate: 1, endDate: 1 });
tournamentSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model("Tournament", tournamentSchema);

const mongoose = require("mongoose");

const announcementSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["info", "important", "promo"],
      default: "info",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    startsAt: {
      type: Date,
      default: null,
    },
    endsAt: {
      type: Date,
      default: null,
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

announcementSchema.index({ companyId: 1, isActive: 1 });

module.exports = mongoose.model("Announcement", announcementSchema);

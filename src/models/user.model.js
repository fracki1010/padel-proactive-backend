// src/models/user.model.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
    },
    whatsappId: {
      type: String,
      required: true,
      trim: true, // El ID de WhatsApp (ej: 5491122334455@c.us)
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    phoneNumber: {
      type: String,
      required: true,
    },
    level: {
      type: String,
      enum: ["principiante", "intermedio", "avanzado", "pro"],
      default: "intermedio",
    },
    fixedTurns: [
      {
        court: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Court",
          required: true,
        },
        dayOfWeek: {
          type: Number, // 0-6 (Sunday-Saturday)
          required: true,
        },
        timeSlot: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "TimeSlot",
          required: true,
        },
      },
    ],
    lastInteraction: {
      type: Date,
      default: Date.now,
    },
    penalties: {
      type: Number,
      default: 0,
    },
    isSuspended: {
      type: Boolean,
      default: false,
    },
    attendanceConfirmedCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

userSchema.index({ companyId: 1, whatsappId: 1 }, { unique: true });

module.exports = mongoose.model("User", userSchema);

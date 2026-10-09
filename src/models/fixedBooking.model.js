const mongoose = require("mongoose");

// Fixed weekly turn: blocks the same court + timeSlot on a weekday every week.
// Unlike the legacy `User.fixedTurns` materialization, a FixedBooking is a
// court-level block owned by the club: it marks the slot as unavailable on the
// public portal and the admin grid, and refuses direct booking creation on it.
//
// Weekday follows the JS Date convention: 0=DOM (Sunday) ... 6=SÁB (Saturday).
const fixedBookingSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    court: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Court",
      required: true,
    },
    timeSlot: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TimeSlot",
      required: true,
    },
    weekday: {
      type: Number,
      required: true,
      enum: [0, 1, 2, 3, 4, 5, 6],
    },
    // Every fixed turn is owned by a client: the name is required end-to-end
    // (model, controller, UI) so the card never shows an anonymous block.
    clientName: { type: String, required: true, trim: true },
    notes: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "paused"],
      default: "active",
    },
  },
  { timestamps: true },
);

// One fixed turn per court + weekday + timeSlot within a company.
fixedBookingSchema.index(
  { companyId: 1, court: 1, weekday: 1, timeSlot: 1 },
  { unique: true },
);

// Booking dates are stored as UTC midnight (see booking.model.js), so the
// weekday MUST be derived in UTC. Using `getDay()` would shift the weekday by
// one in non-UTC timezones west of UTC (e.g. America/Argentina/Buenos_Aires).
// Single source of truth: fixedBooking.service re-exports this helper and every
// fixed-turn weekday computation (availability, conflict guards) uses it.
const getWeekdayFromDate = (date = new Date()) => {
  const value = date instanceof Date ? date : new Date(date);
  return value.getUTCDay();
};

const FixedBooking = mongoose.model("FixedBooking", fixedBookingSchema);
FixedBooking.getWeekdayFromDate = getWeekdayFromDate;

module.exports = FixedBooking;
module.exports.getWeekdayFromDate = getWeekdayFromDate;

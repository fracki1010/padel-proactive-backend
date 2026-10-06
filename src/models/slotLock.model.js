const mongoose = require("mongoose");

// How long a holder keeps a slot reserved while finishing the booking flow.
const SLOT_LOCK_TTL_MS = Number(process.env.SLOT_LOCK_TTL_MS || 5 * 60 * 1000);

const slotLockSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    courtId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Court",
      required: true,
    },
    slotId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TimeSlot",
      required: true,
    },
    // Calendar date at UTC midnight — same convention as Booking.date.
    date: {
      type: Date,
      required: true,
    },
    // Anonymous browser holder id or authenticated client id.
    holderId: {
      type: String,
      required: true,
      trim: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true },
);

// TTL index: MongoDB removes the document once expiresAt is reached.
slotLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Uniqueness strategy.
// The TTL monitor runs roughly once per minute, so an expired document can
// linger briefly after expiresAt. A plain unique index would then reject a
// valid new lock with E11000. To stay safe we keep the unique index as the
// hard concurrency guard but delete lingering expired locks for the target
// slot before every acquire (see slotLock.service). Live locks still collide
// through the unique index, which is exactly what we want.
slotLockSchema.index(
  { companyId: 1, courtId: 1, slotId: 1, date: 1 },
  { unique: true },
);

const SlotLock = mongoose.model("SlotLock", slotLockSchema);

module.exports = SlotLock;
module.exports.SLOT_LOCK_TTL_MS = SLOT_LOCK_TTL_MS;

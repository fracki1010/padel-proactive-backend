"use strict";

// Temporary slot lock domain.
//
// A lock is a short-lived reservation that lets one visitor finish the booking
// flow without another visitor taking the same slot in the meantime. Locks are
// pure UX: the Booking unique index is still the real anti-double-booking
// guarantee. The decision logic here is decoupled from Mongoose through a small
// `store` interface so it can be exercised in unit tests and reused elsewhere.

const Booking = require("../models/booking.model");
const SlotLock = require("../models/slotLock.model");

const { SLOT_LOCK_TTL_MS } = SlotLock;

const toTime = (value) =>
  value instanceof Date ? value.getTime() : new Date(value).getTime();

const isLockActive = (lock, now = new Date()) =>
  Boolean(lock && lock.expiresAt) && toTime(lock.expiresAt) > toTime(now);

const isOwnedBy = (lock, holderId) =>
  Boolean(lock) && String(lock.holderId) === String(holderId);

const computeLockExpiry = (now = new Date(), ttlMs = SLOT_LOCK_TTL_MS) =>
  new Date(toTime(now) + Number(ttlMs));

const resolveLockOutcome = ({
  activeBooking,
  activeLocks = [],
  holderId,
  now = new Date(),
}) => {
  if (activeBooking) return { ok: false, reason: "booked" };

  const liveLocks = activeLocks.filter((lock) => isLockActive(lock, now));
  const foreignLock = liveLocks.find((lock) => !isOwnedBy(lock, holderId));
  if (foreignLock) {
    return { ok: false, reason: "locked_by_other", lock: foreignLock };
  }

  const renewLock = liveLocks.find((lock) => isOwnedBy(lock, holderId)) || null;
  return { ok: true, renewLock };
};

const acquireSlotLock = async ({
  companyId,
  courtId,
  slotId,
  date,
  holderId,
  ttlMs = SLOT_LOCK_TTL_MS,
  now = new Date(),
  store,
}) => {
  if (!store) throw new Error("acquireSlotLock requires a store");

  // Remove lingering expired documents first so the unique index does not
  // reject a perfectly valid new lock (TTL monitor is not instantaneous).
  await store.deleteExpiredLocks({ companyId, courtId, slotId, date, now });

  const [activeBooking, activeLocks] = await Promise.all([
    store.findActiveBooking({ companyId, courtId, slotId, date }),
    store.findActiveLocks({ companyId, courtId, slotId, date, now }),
  ]);

  const outcome = resolveLockOutcome({ activeBooking, activeLocks, holderId, now });
  if (!outcome.ok) return outcome;

  const expiresAt = computeLockExpiry(now, ttlMs);

  try {
    const lock = await store.upsertLock({
      companyId,
      courtId,
      slotId,
      date,
      holderId,
      expiresAt,
    });
    return { ok: true, lock, expiresAt };
  } catch (err) {
    // Lost the race against another holder: the unique index rejected the
    // insert because a live lock already owns the slot.
    if (err && err.code === 11000) return { ok: false, reason: "locked_by_other" };
    throw err;
  }
};

const releaseSlotLock = async ({ companyId, lockId, holderId, store }) => {
  if (!store) throw new Error("releaseSlotLock requires a store");
  const result = await store.deleteOwnLock({ companyId, lockId, holderId });
  return { ok: Boolean(result && result.deletedCount > 0) };
};

const buildForeignLockedKeys = (locks = [], holderId, now = new Date()) => {
  const keys = new Set();
  for (const lock of locks) {
    if (!isLockActive(lock, now)) continue;
    if (holderId && isOwnedBy(lock, holderId)) continue;
    keys.add(`${String(lock.courtId)}_${String(lock.slotId)}`);
  }
  return keys;
};

const applyLocksToAvailability = ({
  availability = [],
  locks = [],
  holderId = null,
  now = new Date(),
}) => {
  const foreignLockedKeys = buildForeignLockedKeys(locks, holderId, now);
  if (foreignLockedKeys.size === 0) return availability;

  return availability.map((item) => {
    const key = `${String(item.courtId)}_${String(item.slotId)}`;
    if (item.available && foreignLockedKeys.has(key)) {
      return { ...item, available: false, locked: true };
    }
    return item;
  });
};

// Adapter over Mongoose used by the public controller.
const createMongooseSlotLockStore = () => ({
  deleteExpiredLocks: ({ companyId, courtId, slotId, date, now }) =>
    SlotLock.deleteMany({
      companyId,
      courtId,
      slotId,
      date,
      expiresAt: { $lte: now },
    }),

  findActiveBooking: ({ companyId, courtId, slotId, date }) =>
    Booking.findOne({
      companyId,
      court: courtId,
      timeSlot: slotId,
      date,
      status: { $nin: ["cancelado"] },
    })
      .select("_id")
      .lean(),

  findActiveLocks: ({ companyId, courtId, slotId, date, now }) =>
    SlotLock.find({
      companyId,
      courtId,
      slotId,
      date,
      expiresAt: { $gt: now },
    }).lean(),

  findActiveLocksForDate: ({ companyId, date, now }) =>
    SlotLock.find({ companyId, date, expiresAt: { $gt: now } })
      .select("courtId slotId holderId expiresAt")
      .lean(),

  upsertLock: ({ companyId, courtId, slotId, date, holderId, expiresAt }) =>
    SlotLock.findOneAndUpdate(
      { companyId, courtId, slotId, date, holderId },
      { $set: { expiresAt } },
      { new: true, upsert: true },
    ).lean(),

  deleteOwnLock: ({ companyId, lockId, holderId }) =>
    SlotLock.deleteOne({ _id: lockId, companyId, holderId }),

  deleteLocksForSlot: ({ companyId, courtId, slotId, date }) =>
    SlotLock.deleteMany({ companyId, courtId, slotId, date }),
});

module.exports = {
  SLOT_LOCK_TTL_MS,
  isLockActive,
  isOwnedBy,
  computeLockExpiry,
  resolveLockOutcome,
  acquireSlotLock,
  releaseSlotLock,
  buildForeignLockedKeys,
  applyLocksToAvailability,
  createMongooseSlotLockStore,
};

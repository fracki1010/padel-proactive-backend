'use strict';

// Pure planner for the "general slots → per-court" migration.
//
// The club moves to per-court schedules only: every GENERAL slot (court == null)
// is copied into each active court as an OWNED slot, then the general ones are
// deleted. A court that already owns a slot with the same startTime keeps its
// own (the general copy is skipped) — never duplicating a time for a court.

const slotCourtId = (slot = {}) => (slot.court ? String(slot.court) : '');

const planPerCourtConversion = ({
  generalSlots = [],
  courts = [],
  ownedSlots = [],
} = {}) => {
  // startTimes already owned per court (from the current data)
  const ownedByCourt = new Map();
  for (const slot of ownedSlots) {
    const courtId = slotCourtId(slot);
    if (!courtId) continue;
    if (!ownedByCourt.has(courtId)) ownedByCourt.set(courtId, new Set());
    ownedByCourt.get(courtId).add(String(slot.startTime));
  }

  const toCreate = [];
  let skipped = 0;

  for (const court of courts) {
    const courtId = String(court._id);
    if (!ownedByCourt.has(courtId)) ownedByCourt.set(courtId, new Set());
    const existing = ownedByCourt.get(courtId);

    for (const general of generalSlots) {
      const startTime = String(general.startTime);
      // Skip if the court already owns this startTime (pre-existing or created
      // earlier in this same plan — also dedupes repeated general startTimes).
      if (existing.has(startTime)) {
        skipped += 1;
        continue;
      }
      existing.add(startTime);
      toCreate.push({ court: court._id, source: general });
    }
  }

  return {
    toCreate,
    skipped,
    toDeleteIds: generalSlots.map((slot) => slot._id),
  };
};

module.exports = { planPerCourtConversion, slotCourtId };

'use strict';

// Pure scheduling helpers for per-court time slots.
//
// Two rules live here and are reused everywhere availability is computed
// (public portal, booking service and the config routes) so they cannot drift:
//
//   1. A slot's `endTime` is DERIVED from `startTime` + `durationMinutes`.
//      Times are clock-only (HH:MM); a duration that crosses midnight wraps
//      into the next day's clock time (23:30 + 60 -> 00:30).
//
//   2. OVERRIDE RULE — for a given court, its OWN active slots win. Only when
//      the court has no own slots does it fall back to the GENERAL slots
//      (slots whose `court` is null). Each court is resolved independently.

const TIME_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MIN_DURATION_MINUTES = 15;
const MAX_DURATION_MINUTES = 480;
const MINUTES_PER_DAY = 24 * 60;

const parseTimeToMinutes = (time) => {
  const value = typeof time === "string" ? time.trim() : "";
  if (!TIME_REGEX.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

const formatMinutesToTime = (totalMinutes) => {
  const normalized =
    ((Math.trunc(totalMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

const deriveEndTime = (startTime, durationMinutes) => {
  const start = parseTimeToMinutes(startTime);
  const duration = Number(durationMinutes);
  if (start === null || !Number.isFinite(duration) || duration <= 0) return null;
  return formatMinutesToTime(start + duration);
};

const isValidDuration = (value) =>
  Number.isInteger(value) &&
  value >= MIN_DURATION_MINUTES &&
  value <= MAX_DURATION_MINUTES;

const courtIdOf = (slot) => (slot && slot.court ? String(slot.court) : "");

// Splits a flat slot list into the GENERAL list (court == null) and a Map of
// courtId -> own slots. Insertion order is preserved.
const groupSlotsByCourt = (slots = []) => {
  const general = [];
  const byCourt = new Map();

  for (const slot of slots) {
    const courtId = courtIdOf(slot);
    if (!courtId) {
      general.push(slot);
      continue;
    }
    if (!byCourt.has(courtId)) byCourt.set(courtId, []);
    byCourt.get(courtId).push(slot);
  }

  return { general, byCourt };
};

// The override rule for a single court.
const slotsForCourt = (courtId, generalSlots = [], byCourt = new Map()) => {
  const own = courtId ? byCourt.get(String(courtId)) : null;
  if (own && own.length > 0) return own;
  return generalSlots;
};

// Union of every court's effective slots, deduplicated by `_id`. This is the
// set of slots that actually applies to at least one court — orphan per-court
// slots of inactive courts are excluded.
const collectEffectiveSlots = (
  courts = [],
  generalSlots = [],
  byCourt = new Map(),
) => {
  const seen = new Set();
  const result = [];

  for (const court of courts) {
    for (const slot of slotsForCourt(court?._id, generalSlots, byCourt)) {
      const id = String(slot._id);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(slot);
    }
  }

  return result;
};

// Public availability matrix: for every court, emit one pair per effective slot
// (own slots if any, else general). `occupiedSet` keys are `courtId_slotId`.
const buildAvailabilityPairs = ({
  courts = [],
  slots = [],
  occupiedSet = new Set(),
} = {}) => {
  const { general, byCourt } = groupSlotsByCourt(slots);

  return courts.flatMap((court) =>
    slotsForCourt(court?._id, general, byCourt).map((slot) => ({
      courtId: String(court._id),
      slotId: String(slot._id),
      available: !occupiedSet.has(
        `${String(court._id)}_${String(slot._id)}`,
      ),
    })),
  );
};

module.exports = {
  TIME_REGEX,
  MIN_DURATION_MINUTES,
  MAX_DURATION_MINUTES,
  parseTimeToMinutes,
  formatMinutesToTime,
  deriveEndTime,
  isValidDuration,
  groupSlotsByCourt,
  slotsForCourt,
  collectEffectiveSlots,
  buildAvailabilityPairs,
};

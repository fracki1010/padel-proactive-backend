#!/usr/bin/env node
'use strict';

// Backfill `durationMinutes` for legacy TimeSlots that predate duration-based
// slot creation. The value is derived from the stored startTime/endTime (the
// same clock-only convention the routes use, wrapping past midnight).
//
// Safety:
//   - Idempotent: slots that already have a valid duration are skipped.
//   - `court` is intentionally left untouched (null = general slot).
//   - `--dry-run` reports what WOULD change without writing.
//
// Usage:
//   npm run migrate:slot-duration
//   npm run migrate:slot-duration -- --dry-run

const { parseTimeToMinutes } = require('../src/utils/slotSchedule');

const MINUTES_PER_DAY = 24 * 60;

const computeDurationMinutes = (startTime, endTime) => {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  if (start === null || end === null) return null;

  let diff = end - start;
  if (diff <= 0) diff += MINUTES_PER_DAY;
  return diff;
};

// Given the current slot documents, returns the updates needed to fill in a
// missing `durationMinutes`. Pure and side-effect free so it can be unit tested.
const planSlotDurationUpdates = (slots = []) =>
  slots
    .filter(
      (slot) =>
        slot.durationMinutes === null ||
        slot.durationMinutes === undefined ||
        !Number.isInteger(slot.durationMinutes),
    )
    .map((slot) => ({
      id: slot._id,
      durationMinutes: computeDurationMinutes(slot.startTime, slot.endTime),
    }))
    .filter(
      (update) =>
        Number.isInteger(update.durationMinutes) && update.durationMinutes > 0,
    );

const parseArgs = (argv = process.argv.slice(2)) => ({
  dryRun: argv.includes('--dry-run'),
});

const run = async () => {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const connectDB = require('../src/config/database');
  const TimeSlot = require('../src/models/timeSlot.model');

  const { dryRun } = parseArgs();

  await connectDB();

  const slots = await TimeSlot.find({
    $or: [
      { durationMinutes: { $exists: false } },
      { durationMinutes: null },
    ],
  }).lean();

  const updates = planSlotDurationUpdates(slots);
  console.log(
    `[backfillSlotDuration] ${slots.length} slot(s) without duration, ${updates.length} to update${dryRun ? ' (dry-run)' : ''}.`,
  );

  if (!dryRun) {
    for (const update of updates) {
      await TimeSlot.updateOne(
        { _id: update.id },
        { $set: { durationMinutes: update.durationMinutes } },
      );
    }
    console.log(`[backfillSlotDuration] updated ${updates.length} slot(s).`);
  } else {
    for (const update of updates) {
      console.log(`  - ${update.id}: ${update.durationMinutes} min`);
    }
  }

  await mongoose.connection.close();
  return updates.length;
};

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[backfillSlotDuration] error:', error?.message || error);
      process.exit(1);
    });
}

module.exports = { computeDurationMinutes, planSlotDurationUpdates, run };

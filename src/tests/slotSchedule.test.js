'use strict';

// Pure scheduling helpers shared by the slot routes, the public availability
// endpoint and the booking service. These tests pin the two rules that make
// per-court schedules safe:
//   1. endTime is DERIVED from startTime + durationMinutes (no end-time input)
//   2. a court that has its OWN active slots ignores the general slots,
//      otherwise it falls back to the general slots (override rule, per court)
// No database or network is involved: the module is pure.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  TIME_REGEX,
  MIN_DURATION_MINUTES,
  MAX_DURATION_MINUTES,
  deriveEndTime,
  isValidDuration,
  groupSlotsByCourt,
  slotsForCourt,
  collectEffectiveSlots,
  buildAvailabilityPairs,
} = require('../utils/slotSchedule');

// ── deriveEndTime ────────────────────────────────────────────────────────────

test('deriveEndTime adds the duration to the start time', () => {
  assert.equal(deriveEndTime('20:00', 90), '21:30');
  assert.equal(deriveEndTime('20:00', 15), '20:15');
  assert.equal(deriveEndTime('09:05', 120), '11:05');
});

test('deriveEndTime wraps past midnight into the same clock day', () => {
  assert.equal(deriveEndTime('23:30', 60), '00:30');
  assert.equal(deriveEndTime('23:00', 180), '02:00');
});

test('deriveEndTime returns null for an invalid start time or duration', () => {
  assert.equal(deriveEndTime('24:00', 60), null);
  assert.equal(deriveEndTime('8:00', 60), null);
  assert.equal(deriveEndTime('20:00', 0), null);
  assert.equal(deriveEndTime('20:00', -30), null);
  assert.equal(deriveEndTime('', 60), null);
});

// ── duration + time validation ────────────────────────────────────────────────

test('isValidDuration accepts integers within the 15..480 minute bounds', () => {
  assert.equal(isValidDuration(MIN_DURATION_MINUTES), true);
  assert.equal(isValidDuration(MAX_DURATION_MINUTES), true);
  assert.equal(isValidDuration(90), true);
  assert.equal(isValidDuration(14), false);
  assert.equal(isValidDuration(481), false);
  assert.equal(isValidDuration(60.5), false);
  assert.equal(isValidDuration('60'), false);
  assert.equal(isValidDuration(NaN), false);
});

test('TIME_REGEX only matches a strict 24h HH:MM clock time', () => {
  assert.equal(TIME_REGEX.test('00:00'), true);
  assert.equal(TIME_REGEX.test('23:59'), true);
  assert.equal(TIME_REGEX.test('24:00'), false);
  assert.equal(TIME_REGEX.test('8:00'), false);
  assert.equal(TIME_REGEX.test('20:60'), false);
  assert.equal(TIME_REGEX.test('tarde'), false);
});

// ── override rule ─────────────────────────────────────────────────────────────

const GENERAL_20 = { _id: 's-20', startTime: '20:00', endTime: '21:00', court: null };
const GENERAL_21 = { _id: 's-21', startTime: '21:00', endTime: '22:00', court: null };
const OWN_A_10 = { _id: 's-10a', startTime: '10:00', endTime: '11:00', court: 'court-A' };
const COURT_A = { _id: 'court-A' };
const COURT_B = { _id: 'court-B' };

test('groupSlotsByCourt splits general slots from per-court slots', () => {
  const { general, byCourt } = groupSlotsByCourt([
    GENERAL_20,
    OWN_A_10,
    { _id: 's-11b', court: 'court-B' },
  ]);

  assert.deepEqual(
    general.map((s) => s._id),
    ['s-20'],
  );
  assert.deepEqual(
    byCourt.get('court-A').map((s) => s._id),
    ['s-10a'],
  );
  assert.deepEqual(
    byCourt.get('court-B').map((s) => s._id),
    ['s-11b'],
  );
});

test('slotsForCourt returns own slots when the court has any, ignoring general', () => {
  const { general, byCourt } = groupSlotsByCourt([GENERAL_20, OWN_A_10]);

  assert.deepEqual(
    slotsForCourt('court-A', general, byCourt).map((s) => s._id),
    ['s-10a'],
  );
});

test('slotsForCourt falls back to the general slots for a court without own slots', () => {
  const { general, byCourt } = groupSlotsByCourt([GENERAL_20, GENERAL_21]);

  assert.deepEqual(
    slotsForCourt('court-A', general, byCourt).map((s) => s._id),
    ['s-20', 's-21'],
  );
});

test('collectEffectiveSlots unions per-court slots deduplicated by id', () => {
  const slots = [GENERAL_20, GENERAL_21, OWN_A_10];
  const { general, byCourt } = groupSlotsByCourt(slots);

  // Court A uses its own [10:00]; court B falls back to the general set.
  assert.deepEqual(
    collectEffectiveSlots([COURT_A, COURT_B], general, byCourt).map((s) => s._id),
    ['s-10a', 's-20', 's-21'],
  );
});

// ── public availability pairs ────────────────────────────────────────────────

test('buildAvailabilityPairs keeps the general cartesian product when no court owns slots', () => {
  const pairs = buildAvailabilityPairs({
    courts: [COURT_A, COURT_B],
    slots: [GENERAL_20, GENERAL_21],
  });

  assert.equal(pairs.length, 4);
  assert.ok(pairs.some((p) => p.courtId === 'court-A' && p.slotId === 's-20'));
  assert.ok(pairs.some((p) => p.courtId === 'court-B' && p.slotId === 's-21'));
  assert.ok(pairs.every((p) => p.available === true));
});

test('buildAvailabilityPairs applies the override rule per court', () => {
  const pairs = buildAvailabilityPairs({
    courts: [COURT_A, COURT_B],
    slots: [GENERAL_20, OWN_A_10],
  });

  const keys = pairs.map((p) => `${p.courtId}_${p.slotId}`).sort();
  // Court A only offers its own 10:00; court B only offers the general 20:00.
  assert.deepEqual(keys, ['court-A_s-10a', 'court-B_s-20']);
});

test('buildAvailabilityPairs marks occupied court+slot pairs unavailable', () => {
  const pairs = buildAvailabilityPairs({
    courts: [COURT_A, COURT_B],
    slots: [GENERAL_20],
    occupiedSet: new Set(['court-A_s-20']),
  });

  const a = pairs.find((p) => p.courtId === 'court-A');
  const b = pairs.find((p) => p.courtId === 'court-B');
  assert.equal(a.available, false);
  assert.equal(b.available, true);
});

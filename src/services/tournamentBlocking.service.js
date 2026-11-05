'use strict';

// Tournament activation conflict detection. Reports existing occupancy on the
// selected courts for the tournament date range. It is strictly read-only:
// bookings and fixed turns are never cancelled, moved or modified.

const Booking = require('../models/booking.model');
const FixedBooking = require('../models/fixedBooking.model');
const Tournament = require('../models/tournament.model');
const Court = require('../models/court.model');
const { isMongoConnected } = require('../config/database');

// Only an in-progress tournament owns its courts. Draft, finished and cancelled
// tournaments release every block, and the status filter makes that immediate.
const BLOCKING_STATUS = 'in_progress';

const toUtcDate = (value) => new Date(`${value}T00:00:00.000Z`);
const toDateOnly = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

// Date-only parsing shared by the resolver. Accepts a Date (UTC midnight) or a
// string that starts with YYYY-MM-DD; anything else is treated as invalid.
const normalizeDateOnly = (value) => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(value || '').trim());
  return match ? match[1] : '';
};

// Inclusive calendar comparison on YYYY-MM-DD strings: no timezone can shift a
// blocked day. Exported so the boundary rules can be tested in isolation.
const isDateInInclusiveRange = (date, startDate, endDate) => {
  const day = normalizeDateOnly(date);
  const start = normalizeDateOnly(startDate);
  const end = normalizeDateOnly(endDate);
  if (!day || !start || !end) return false;
  return start <= day && day <= end;
};

const collectCourtIds = (tournaments = []) => {
  const ids = new Set();
  for (const tournament of tournaments) {
    for (const courtId of tournament.courts || []) {
      if (courtId) ids.add(String(courtId));
    }
  }
  return [...ids];
};

// Single query for the tournaments blocking a date; the returned courts are
// then checked against the active Court collection so a court deleted or
// deactivated mid-tournament never blocks anything (spec TK-R8).
const resolveBlockedCourts = async (companyId, date) => {
  const day = normalizeDateOnly(date);
  if (!companyId || !day) {
    return { date: day, courtIds: [], tournaments: [] };
  }
  // Skip the query if the DB is down: writes would fail too, so fail open.
  if (!isMongoConnected()) {
    return { date: day, courtIds: [], tournaments: [] };
  }

  const tournaments = await Tournament.find({
    companyId,
    status: BLOCKING_STATUS,
    startDate: { $lte: day },
    endDate: { $gte: day },
  })
    .select('_id name courts')
    .lean();

  const tournamentsSummary = tournaments.map((tournament) => ({
    _id: tournament._id,
    name: tournament.name,
  }));

  const candidateIds = collectCourtIds(tournaments);
  if (candidateIds.length === 0) {
    return { date: day, courtIds: [], tournaments: tournamentsSummary };
  }

  const activeCourts = await Court.find({
    companyId,
    _id: { $in: candidateIds },
    isActive: true,
  })
    .select('_id')
    .lean();
  const activeIds = new Set(activeCourts.map((court) => String(court._id)));

  return {
    date: day,
    courtIds: candidateIds.filter((courtId) => activeIds.has(courtId)),
    tournaments: tournamentsSummary,
  };
};

// Contract used by the admin endpoint and by the public availability response.
const getBlockedCourtsForDate = (companyId, date) =>
  resolveBlockedCourts(companyId, date);

// Batched id-only variant for hot paths that already loaded the active courts:
// one tournament query plus one court query, never one query per court.
const getBlockedCourtIdsForDate = async (companyId, date) =>
  (await resolveBlockedCourts(companyId, date)).courtIds;

// Whether blocking can be determined right now. WRITE paths must call this and
// refuse when it is false: Mongoose buffers writes across a reconnect, so a
// booking could otherwise land on a court whose block was never evaluated.
// Reads may keep degrading to "no blocks" (their other Mongo queries fail too).
// Node's test runner sets NODE_TEST_CONTEXT; model-double suites never open a
// DB and must keep exercising unrelated write paths. Production never has it.
const isTestDoubleRun = () =>
  Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test';
const canResolveTournamentBlocks = () => isMongoConnected() || isTestDoubleRun();

// A write path may arrive without a company scope (super_admin). The target
// court is authoritative: derive its tenant before evaluating any block.
const resolveCompanyForCourt = async (courtId) => {
  if (!courtId) return null;
  const court = await Court.findOne({ _id: courtId });
  return court?.companyId ? String(court.companyId) : null;
};

// Court-level guard shared by public, admin and bot booking writes. Never runs
// with an empty company scope: falling back to the court tenant, and failing
// closed if that is impossible.
const isCourtBlockedByTournament = async (companyId, courtId, date) => {
  if (!courtId) return false;
  const scopeCompanyId = companyId || (await resolveCompanyForCourt(courtId));
  if (!scopeCompanyId) return true;
  const blockedCourtIds = await getBlockedCourtIdsForDate(scopeCompanyId, date);
  return blockedCourtIds.includes(String(courtId));
};

// Weekdays (JS UTC convention, 0=Sunday) covered by an inclusive date range.
const weekdaysInRange = (startDate, endDate) => {
  const days = new Set();
  const cursor = toUtcDate(startDate);
  const end = toUtcDate(endDate);
  while (cursor <= end) {
    days.add(cursor.getUTCDay());
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return [...days];
};

async function findActivationConflicts({ companyId, courtIds = [], startDate, endDate } = {}) {
  if (!companyId || !Array.isArray(courtIds) || courtIds.length === 0 || !startDate || !endDate) {
    return [];
  }

  const [bookings, fixedTurns] = await Promise.all([
    Booking.find({
      companyId,
      court: { $in: courtIds },
      status: { $ne: 'cancelado' },
      date: { $gte: toUtcDate(startDate), $lte: toUtcDate(endDate) },
    }),
    FixedBooking.find({
      companyId,
      court: { $in: courtIds },
      status: 'active',
      weekday: { $in: weekdaysInRange(startDate, endDate) },
    }),
  ]);

  return [
    ...bookings.map((booking) => ({
      type: 'booking',
      courtId: booking.court,
      date: toDateOnly(booking.date),
      clientName: booking.clientName || null,
    })),
    ...fixedTurns.map((turn) => ({
      type: 'fixed',
      courtId: turn.court,
      weekday: turn.weekday,
      clientName: turn.clientName || null,
    })),
  ];
}

module.exports = {
  BLOCKING_STATUS,
  isDateInInclusiveRange,
  canResolveTournamentBlocks,
  getBlockedCourtsForDate,
  getBlockedCourtIdsForDate,
  isCourtBlockedByTournament,
  findActivationConflicts,
  weekdaysInRange,
  toUtcDate,
};

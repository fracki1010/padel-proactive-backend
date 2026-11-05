'use strict';

// Tournament activation conflict detection. Reports existing occupancy on the
// selected courts for the tournament date range. It is strictly read-only:
// bookings and fixed turns are never cancelled, moved or modified.

const Booking = require('../models/booking.model');
const FixedBooking = require('../models/fixedBooking.model');

const toUtcDate = (value) => new Date(`${value}T00:00:00.000Z`);
const toDateOnly = (value) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

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

module.exports = { findActivationConflicts, weekdaysInRange, toUtcDate };

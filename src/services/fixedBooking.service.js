const FixedBooking = require("../models/fixedBooking.model");

const buildCompanyFilter = (companyId = null) => ({ companyId: companyId || null });

// Weekday of a booking date. Booking dates are stored as UTC midnight, so the
// UTC weekday is the canonical one (see fixedBooking.model.js).
const getWeekdayFromDate = (date) => {
  const value = date instanceof Date ? date : new Date(date);
  return value.getUTCDay();
};

/**
 * List fixed turns for a company, optionally filtered by weekday and status.
 * Sorted by weekday and then by the referenced time slot order.
 */
const listFixedBookings = async (companyId, { weekday, status } = {}) => {
  const filter = buildCompanyFilter(companyId);
  if (weekday !== undefined && weekday !== null) filter.weekday = Number(weekday);
  if (status) filter.status = status;

  const fixedBookings = await FixedBooking.find(filter)
    .populate("court", "name")
    .populate("timeSlot", "startTime endTime order label");

  return fixedBookings.sort((a, b) => {
    if (a.weekday !== b.weekday) return a.weekday - b.weekday;
    const orderA = a.timeSlot?.order ?? 0;
    const orderB = b.timeSlot?.order ?? 0;
    return orderA - orderB;
  });
};

/**
 * Active fixed turns colliding with a given court + weekday + timeSlot.
 * Pass `excludeId` on updates so a fixed turn does not conflict with itself.
 */
const getConflicts = async ({ companyId, weekday, court, timeSlot, excludeId } = {}) => {
  const filter = {
    ...buildCompanyFilter(companyId),
    weekday: Number(weekday),
    court,
    timeSlot,
    status: "active",
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return FixedBooking.find(filter);
};

/**
 * The active fixed turn, if any, that blocks creating a booking on `date` for
 * `courtId` + `timeSlotId`. Returns the conflicting document or null.
 */
const findConflictingFixedForBooking = async ({
  companyId,
  date,
  courtId,
  timeSlotId,
} = {}) => {
  const weekday = getWeekdayFromDate(date);
  if (Number.isNaN(weekday)) return null;

  return FixedBooking.findOne({
    ...buildCompanyFilter(companyId),
    weekday,
    court: courtId,
    timeSlot: timeSlotId,
    status: "active",
  });
};

module.exports = {
  listFixedBookings,
  getConflicts,
  findConflictingFixedForBooking,
  getWeekdayFromDate,
};

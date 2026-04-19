const Booking = require("../models/booking.model");
const User = require("../models/user.model");
const { normalizeClientIdentity } = require("../utils/identityNormalization");

const DEFAULT_MATERIALIZATION_DAYS_AHEAD = Number(
  process.env.FIXED_TURNS_MATERIALIZATION_DAYS_AHEAD || 90,
);

const buildCompanyFilter = (companyId = null) =>
  companyId === undefined ? {} : { companyId: companyId || null };

const normalizeDateToUtcMidnight = (value) => {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const getUsersWithFixedTurnsForDay = async ({ companyId = null, dayOfWeek }) => {
  const scope = buildCompanyFilter(companyId);
  return User.find({
    ...scope,
    "fixedTurns.dayOfWeek": dayOfWeek,
  })
    .populate("fixedTurns.timeSlot")
    .populate("fixedTurns.court");
};

const materializeFixedBookingsForDate = async ({
  companyId = null,
  searchDate,
  users = null,
}) => {
  const scope = buildCompanyFilter(companyId);
  const normalizedSearchDate = normalizeDateToUtcMidnight(searchDate);
  if (!normalizedSearchDate) {
    return { createdCount: 0, skippedCount: 0 };
  }

  const dayOfWeek = normalizedSearchDate.getUTCDay();
  const usersWithFixedTurns = Array.isArray(users)
    ? users
    : await getUsersWithFixedTurnsForDay({ companyId, dayOfWeek });

  let createdCount = 0;
  let skippedCount = 0;

  for (const user of usersWithFixedTurns) {
    for (const fixedTurn of user.fixedTurns || []) {
      if (fixedTurn.dayOfWeek !== dayOfWeek) continue;
      if (!fixedTurn?.court?._id || !fixedTurn?.timeSlot?._id) {
        skippedCount += 1;
        continue;
      }

      const bookingFilter = {
        ...scope,
        court: fixedTurn.court._id,
        date: normalizedSearchDate,
        timeSlot: fixedTurn.timeSlot._id,
      };

      const hasActiveBooking = await Booking.exists({
        ...bookingFilter,
        status: { $ne: "cancelado" },
      });
      if (hasActiveBooking) {
        skippedCount += 1;
        continue;
      }

      // Si el dueño del fijo ya lo canceló para ese día, no se recrea.
      const cancelledByOwner = await Booking.exists({
        ...bookingFilter,
        status: "cancelado",
        clientPhone: user.phoneNumber,
      });
      if (cancelledByOwner) {
        skippedCount += 1;
        continue;
      }

      try {
        const identity = normalizeClientIdentity({
          phone: user.phoneNumber || "",
          whatsappId: user.whatsappId || "",
          chatId: user.whatsappId || "",
        });
        await Booking.create({
          ...scope,
          court: fixedTurn.court._id,
          date: normalizedSearchDate,
          timeSlot: fixedTurn.timeSlot._id,
          clientName: user.name || "Cliente",
          clientPhone: user.phoneNumber || "",
          clientWhatsappId: user.whatsappId || null,
          canonicalClientId: identity.canonicalClientId || null,
          status: "reservado",
          paymentStatus: "pendiente",
          isFixed: true,
          finalPrice: Number(fixedTurn?.timeSlot?.price || 0),
        });
        createdCount += 1;
      } catch (error) {
        if (error?.code === 11000) {
          skippedCount += 1;
          continue;
        }
        throw error;
      }
    }
  }

  return { createdCount, skippedCount };
};

const materializeFixedBookingsInRange = async ({
  companyId = null,
  fromDate = new Date(),
  daysAhead = DEFAULT_MATERIALIZATION_DAYS_AHEAD,
  userId = null,
}) => {
  const scope = buildCompanyFilter(companyId);
  const normalizedFromDate = normalizeDateToUtcMidnight(fromDate);
  if (!normalizedFromDate) {
    return { createdCount: 0, skippedCount: 0, datesProcessed: 0 };
  }

  const safeDaysAhead = Math.max(0, Number(daysAhead) || 0);
  const usersFilter = {
    ...scope,
    "fixedTurns.0": { $exists: true },
  };
  if (userId) {
    usersFilter._id = userId;
  }

  const usersWithFixedTurns = await User.find(usersFilter)
    .populate("fixedTurns.timeSlot")
    .populate("fixedTurns.court");

  if (!usersWithFixedTurns.length) {
    return { createdCount: 0, skippedCount: 0, datesProcessed: 0 };
  }

  let createdCount = 0;
  let skippedCount = 0;
  let datesProcessed = 0;

  for (let offset = 0; offset <= safeDaysAhead; offset += 1) {
    const date = new Date(normalizedFromDate.getTime());
    date.setUTCDate(normalizedFromDate.getUTCDate() + offset);

    const result = await materializeFixedBookingsForDate({
      companyId,
      searchDate: date,
      users: usersWithFixedTurns,
    });
    createdCount += Number(result?.createdCount || 0);
    skippedCount += Number(result?.skippedCount || 0);
    datesProcessed += 1;
  }

  return { createdCount, skippedCount, datesProcessed };
};

module.exports = {
  materializeFixedBookingsForDate,
  materializeFixedBookingsInRange,
};

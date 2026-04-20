// src/services/bookingService.js
const Booking = require("../models/booking.model");
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const User = require("../models/user.model");
const Admin = require("../models/admin.model");
const { sendAdminNotification } = require("./notificationService");
const { formatBookingDateShort } = require("../utils/formatBookingDateShort");
const {
  getCancellationLockHours,
  getPenaltyLimit,
  getPenaltySystemEnabled,
} = require("./appConfig.service");
const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require("./whatsappCommandQueue.service");
const {
  materializeFixedBookingsForDate,
} = require("./fixedTurnsMaterialization.service");
const {
  normalizeCanonicalClientPhone,
  toE164,
} = require("../utils/identityNormalization");
const {
  normalizeClientIdentity,
} = require("../whatsapp/domain/clientIdentity");
const {
  matchBookingsByClient,
} = require("./bookingMatching.service");
const TIMEZONE = "America/Argentina/Buenos_Aires";
const DAILY_BOOKING_LIMIT_PER_CLIENT = Number(
  process.env.DAILY_BOOKING_LIMIT_PER_CLIENT || 3,
);
const buildCompanyFilter = (companyId = null) => ({ companyId: companyId || null });
const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildRequestIdentity = ({ clientPhone = "", clientWhatsappId = "" }) =>
  normalizeClientIdentity({
    phone: clientPhone,
    whatsappId: clientWhatsappId,
    chatId: clientWhatsappId,
    canonicalClientPhone: clientPhone,
  });

const resolveCanonicalClientId = ({ clientPhone = "", clientWhatsappId = "" }) => {
  const identity = normalizeClientIdentity({
    phone: clientPhone,
    whatsappId: clientWhatsappId,
    chatId: clientWhatsappId,
    canonicalClientPhone: clientPhone,
  });
  if (identity.isQaSession && identity.whatsappId) return identity.whatsappId;
  return identity.canonicalPhone || toE164(identity.canonicalPhoneDigits) || null;
};

const getDatePartsInTimezone = (date, timeZone = TIMEZONE) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
};

const getCurrentMinutesInTimezone = (timeZone = TIMEZONE) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return hour * 60 + minute;
};

const dateStringToUtcMidnight = (dateStr) => {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
};

const slotTimeToMinutes = (timeStr) => {
  const [hour, minute] = String(timeStr).split(":").map(Number);
  return hour * 60 + minute;
};

const isPastDateInTimezone = (dateStr, timeZone = TIMEZONE) => {
  const todayStr = getDatePartsInTimezone(new Date(), timeZone);
  return String(dateStr) < todayStr;
};

const isTodayInTimezone = (dateStr, timeZone = TIMEZONE) => {
  const todayStr = getDatePartsInTimezone(new Date(), timeZone);
  return String(dateStr) === todayStr;
};

const hasSlotStarted = (dateStr, timeStr, timeZone = TIMEZONE) => {
  if (isPastDateInTimezone(dateStr, timeZone)) return true;
  if (!isTodayInTimezone(dateStr, timeZone)) return false;
  return slotTimeToMinutes(timeStr) <= getCurrentMinutesInTimezone(timeZone);
};

const getDaysDiffFromTodayInTimezone = (dateStr, timeZone = TIMEZONE) => {
  const todayStr = getDatePartsInTimezone(new Date(), timeZone);
  const currentDayUtc = dateStringToUtcMidnight(todayStr);
  const targetDayUtc = dateStringToUtcMidnight(dateStr);
  const diffMs = targetDayUtc.getTime() - currentDayUtc.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
};

const getMinutesUntilSlotStart = (dateStr, timeStr, timeZone = TIMEZONE) => {
  const daysDiff = getDaysDiffFromTodayInTimezone(dateStr, timeZone);
  const slotMinutes = slotTimeToMinutes(timeStr);
  const nowMinutes = getCurrentMinutesInTimezone(timeZone);
  return daysDiff * 24 * 60 + slotMinutes - nowMinutes;
};

const getCancellationContactPhone = async (companyId = null) => {
  const adminQuery = {
    phone: { $exists: true, $ne: "" },
    isActive: true,
  };
  if (companyId) {
    adminQuery.$or = [{ companyId }, { role: "super_admin" }];
  }

  const admins = await Admin.find(adminQuery).select("phone companyId role").lean();
  if (!admins.length) return "";

  if (!companyId) {
    return String(admins[0].phone || "").trim();
  }

  const companyAdmin = admins.find(
    (admin) => String(admin?.companyId || "") === String(companyId),
  );
  if (companyAdmin?.phone) return String(companyAdmin.phone).trim();

  return String(admins[0].phone || "").trim();
};

/**
 * Crea una nueva reserva.
 * Soporta selección automática ("INDIFERENTE") o específica de cancha.
 */
const createNewBooking = async ({
  companyId = null,
  courtName,
  dateStr,
  timeStr,
  clientName,
  clientPhone,
  clientWhatsappId = null,
  allowSameClientSameSlot = false,
}) => {
  try {
    const scope = buildCompanyFilter(companyId);
    const normalizedClientPhone =
      normalizeCanonicalClientPhone(clientPhone, clientWhatsappId) || String(clientPhone || "");
    const requestIdentityPayload = {
      phone: normalizedClientPhone,
      whatsappId: clientWhatsappId,
      chatId: clientWhatsappId,
      canonicalClientPhone: normalizedClientPhone,
    };
    const canonicalClientId = resolveCanonicalClientId({
      clientPhone: normalizedClientPhone,
      clientWhatsappId,
    });
    // 0. Verificar si el usuario está suspendido
    const user = await User.findOne({ ...scope, phoneNumber: normalizedClientPhone });
    if (user && user.isSuspended) {
      return { success: false, error: "SUSPENDED" };
    }
    const bookingDate = dateStringToUtcMidnight(dateStr);

    if (hasSlotStarted(dateStr, timeStr)) {
      return { success: false, error: "PAST_TIME" };
    }

    await materializeFixedBookingsForDate({
      companyId,
      searchDate: bookingDate,
    });

    // 2. Buscar el TimeSlot correspondiente (Ej: "20:00")
    const slot = await TimeSlot.findOne({ ...scope, startTime: timeStr });
    if (!slot) {
      return { success: false, error: "INVALID_TIME" }; // "Ese horario no existe"
    }

    // 2.0 Límite diario por cliente: máximo 3 reservas activas por día
    const clientDailyBookingsCount = await Booking.countDocuments({
      ...scope,
      clientPhone: normalizedClientPhone,
      date: bookingDate,
      status: { $ne: "cancelado" },
    });

    if (clientDailyBookingsCount >= DAILY_BOOKING_LIMIT_PER_CLIENT) {
      return {
        success: false,
        error: "DAILY_LIMIT_REACHED",
        data: {
          limit: DAILY_BOOKING_LIMIT_PER_CLIENT,
        },
      };
    }

    // 2.1 Evitar duplicados del mismo cliente en la misma fecha/hora
    if (!allowSameClientSameSlot) {
      const slotBookings = await Booking.find({
        ...scope,
        date: bookingDate,
        timeSlot: slot._id,
        status: { $ne: "cancelado" },
      })
        .select("_id clientPhone clientWhatsappId canonicalClientId")
        .lean();

      const matchedClientInSlot = matchBookingsByClient(
        requestIdentityPayload,
        slotBookings,
      );

      if (matchedClientInSlot.matchedBookings.length > 0) {
        const existingClientBooking = matchedClientInSlot.matchedBookings[0];
        return {
          success: false,
          error: "ALREADY_BOOKED",
          data: {
            bookingId: existingClientBooking._id,
            startTime: slot.startTime,
            endTime: slot.endTime,
          },
        };
      }
    }

    let selectedCourt = null;

    // =================================================================
    // ESTRATEGIA DE SELECCIÓN DE CANCHA
    // =================================================================

    const { COURT_TYPES } = require('../models/court.model');

    const busyBookings = await Booking.find({
      ...scope,
      date: bookingDate,
      timeSlot: slot._id,
      status: { $ne: "cancelado" },
    });
    const busyCourtIds = busyBookings.map((b) => b.court.toString());

    // CASO A: AL USUARIO LE DA IGUAL ("INDIFERENTE")
    if (courtName === "INDIFERENTE") {
      const allCourts = await Court.find({ ...scope, isActive: true });
      selectedCourt = allCourts.find(
        (c) => !busyCourtIds.includes(c._id.toString()),
      );
      if (!selectedCourt) return { success: false, error: "BUSY" };
    }
    // CASO B: EL USUARIO ELIGIÓ UN TIPO (Ej: "Techada", "VIP")
    else if (COURT_TYPES.includes(courtName)) {
      const courtsOfType = await Court.find({ ...scope, isActive: true, courtType: courtName });
      selectedCourt = courtsOfType.find(
        (c) => !busyCourtIds.includes(c._id.toString()),
      );
      if (!selectedCourt) return { success: false, error: "BUSY" };
    }
    // CASO C: EL USUARIO ELIGIÓ UNA CANCHA ESPECÍFICA POR NOMBRE
    else {
      const escapedCourtName = escapeRegex(courtName);
      selectedCourt = await Court.findOne({
        ...scope,
        name: { $regex: new RegExp(`^${escapedCourtName}$`, "i") },
      });

      if (!selectedCourt) {
        selectedCourt = await Court.findOne({
          ...scope,
          name: { $regex: escapedCourtName, $options: "i" },
        });
        if (!selectedCourt)
          return { success: false, error: "CANCHA_NOT_FOUND" };
      }

      const existingBooking = await Booking.findOne({
        ...scope,
        court: selectedCourt._id,
        date: bookingDate,
        timeSlot: slot._id,
        status: { $ne: "cancelado" },
      });

      if (existingBooking) return { success: false, error: "BUSY" };
    }

    // =================================================================
    // CREACIÓN DE LA RESERVA
    // =================================================================
    const newBooking = await Booking.create({
      ...scope,
      court: selectedCourt._id,
      date: bookingDate,
      timeSlot: slot._id,
      clientName,
      clientPhone: normalizedClientPhone,
      clientWhatsappId: normalizeClientIdentity({ whatsappId: clientWhatsappId }).whatsappId || null,
      canonicalClientId,
      finalPrice: slot.price, // Congelamos el precio actual
      status: "confirmado",
    });

    // Notificar al admin
    await sendAdminNotification(
      "new_booking",
      "Nuevo Turno (WhatsApp)",
      `Cliente: ${newBooking.clientName}\nFecha: ${formatBookingDateShort(newBooking.date)}\nHora: ${slot.startTime}\nCancha: ${selectedCourt.name}`,
      { bookingId: newBooking._id, companyId },
      { companyId },
    );

    // Retornamos éxito con datos bonitos para el mensaje de WhatsApp
    return {
      success: true,
      data: {
        bookingId: newBooking._id,
        courtName: selectedCourt.name, // Importante: devolvemos el nombre real asignado
        startTime: slot.startTime,
        endTime: slot.endTime,
        price: slot.price,
      },
    };
  } catch (error) {
    // Error de llave duplicada (Doble seguridad de MongoDB)
    if (error.code === 11000) {
      return { success: false, error: "BUSY" };
    }
    console.error("Error bookingService:", error);
    return { success: false, error: "INTERNAL_ERROR" };
  }
};

const hasActiveBookingForClient = async ({
  companyId = null,
  clientPhone,
  clientWhatsappId = null,
}) => {
  try {
    const scope = buildCompanyFilter(companyId);
    const todayStr = getDatePartsInTimezone(new Date());
    const todayDate = dateStringToUtcMidnight(todayStr);

    const candidates = await Booking.find({
      ...scope,
      status: { $ne: "cancelado" },
      date: { $gte: todayDate },
    })
      .select("clientPhone clientWhatsappId canonicalClientId")
      .limit(200)
      .lean();

    const matching = matchBookingsByClient(
      {
        phone: clientPhone,
        whatsappId: clientWhatsappId,
        chatId: clientWhatsappId,
        canonicalClientPhone: clientPhone,
      },
      candidates,
    );

    return matching.matchedBookings.length > 0;
  } catch (error) {
    console.error("Error verificando reservas activas del cliente:", error);
    return false;
  }
};

const getActiveBookingsForClient = async ({
  companyId = null,
  clientPhone,
  clientWhatsappId = null,
  limit = 10,
}) => {
  try {
    const scope = buildCompanyFilter(companyId);
    const todayStr = getDatePartsInTimezone(new Date());
    const todayDate = dateStringToUtcMidnight(todayStr);

    const bookings = await Booking.find({
      ...scope,
      status: { $ne: "cancelado" },
      date: { $gte: todayDate },
    })
      .populate("court", "name")
      .populate("timeSlot", "startTime endTime")
      .sort({ date: 1, createdAt: 1 })
      .lean();

    const matchingResult = matchBookingsByClient(
      {
        phone: clientPhone,
        whatsappId: clientWhatsappId,
        chatId: clientWhatsappId,
        canonicalClientPhone: clientPhone,
      },
      bookings,
    );
    const matchingByClient = matchingResult.matchedBookings;

    // "Reservas vigentes" = reservas activas desde hoy en adelante.
    // No excluimos turnos de hoy que ya empezaron.
    const activeCurrentAndFuture = matchingByClient.filter((booking) =>
      Boolean(booking?.timeSlot?.startTime),
    );

    const sortedUpcoming = activeCurrentAndFuture
      .sort((a, b) => {
      const dateA = getDatePartsInTimezone(new Date(a.date));
      const dateB = getDatePartsInTimezone(new Date(b.date));
      if (dateA !== dateB) return dateA.localeCompare(dateB);
      return String(a?.timeSlot?.startTime || "").localeCompare(
        String(b?.timeSlot?.startTime || ""),
      );
      })
      .slice(0, Math.max(1, Number(limit) || 10));

    return {
      success: true,
      data: sortedUpcoming.map((booking) => ({
        bookingId: booking._id,
        date: getDatePartsInTimezone(new Date(booking.date)),
        courtName: booking?.court?.name || "Cancha",
        startTime: booking?.timeSlot?.startTime || "",
        endTime: booking?.timeSlot?.endTime || "",
        status: booking?.status || "confirmado",
      })),
    };
  } catch (error) {
    console.error("Error obteniendo reservas vigentes del cliente:", error);
    return { success: false, error: "INTERNAL_ERROR", data: [] };
  }
};

/**
 * Consulta disponibilidad filtrando horarios pasados (si es hoy).
 */
const getAvailableSlots = async (dateStr, options = {}) => {
  try {
    const companyId = options.companyId || null;
    const scope = buildCompanyFilter(companyId);
    // 1. Normalizar fecha
    const queryDate = dateStringToUtcMidnight(dateStr);
    const isToday = isTodayInTimezone(dateStr);
    const isPastDate = isPastDateInTimezone(dateStr);

    if (isPastDate) {
      return { success: true, date: dateStr, slots: [] };
    }

    await materializeFixedBookingsForDate({
      companyId,
      searchDate: queryDate,
    });

    // 3. Traer datos maestros
    const allSlots = await TimeSlot.find({ ...scope, isActive: true }).sort({ order: 1 });
    const totalCourtsCount = await Court.countDocuments({ ...scope, isActive: true });

    // 4. Traer reservas
    const bookings = await Booking.find({
      ...scope,
      date: queryDate,
      status: { $ne: "cancelado" },
    });

    // 5. Filtrar
    const availableSlots = allSlots.filter((slot) => {
      // A. Filtro de Capacidad Total
      const bookingsForThisSlot = bookings.filter(
        (b) => b.timeSlot.toString() === slot._id.toString(),
      );
      if (bookingsForThisSlot.length >= totalCourtsCount) return false;

      // B. Filtro de Tiempo Pasado (Solo si es hoy)
      if (isToday) {
        // Si el turno ya comenzó o ya pasó, no se ofrece.
        if (hasSlotStarted(dateStr, slot.startTime)) {
          return false;
        }
      }

      return true;
    });

    const blockedSlots = {};
    for (const slot of allSlots) {
      const bookingsForThisSlot = bookings.filter(
        (b) => b.timeSlot.toString() === slot._id.toString(),
      );
      if (bookingsForThisSlot.length >= totalCourtsCount && totalCourtsCount > 0) {
        blockedSlots[slot.startTime] = {
          isFixed: bookingsForThisSlot.every((b) => b.isFixed === true),
        };
      }
    }

    return {
      success: true,
      date: dateStr,
      slots: availableSlots.map((s) => {
        const bookingsForThisSlot = bookings.filter(
          (b) => b.timeSlot.toString() === s._id.toString(),
        );
        const availableCourts = Math.max(
          0,
          Number(totalCourtsCount) - bookingsForThisSlot.length,
        );
        return {
          time: s.startTime,
          price: s.price,
          availableCourts,
          totalCourts: Number(totalCourtsCount),
        };
      }),
      blockedSlots,
    };
  } catch (error) {
    console.error("Error obteniendo disponibilidad:", error);
    return { success: false, error: "DB_ERROR" };
  }
};

/**
 * Cancela una reserva de un cliente por teléfono, fecha y hora.
 * Aplica una penalización al usuario y lo suspende si llega a 2.
 */
const cancelBooking = async ({
  companyId = null,
  clientPhone,
  clientWhatsappId = null,
  dateStr = "",
  timeStr = "",
}) => {
  try {
    const scope = buildCompanyFilter(companyId);
    const normalizedClientPhone =
      normalizeCanonicalClientPhone(clientPhone, clientWhatsappId) || String(clientPhone || "");
    const hasDateAndTime = Boolean(dateStr) && Boolean(timeStr);

    let booking = null;
    let slot = null;
    let resolvedDateStr = dateStr;
    let resolvedTimeStr = timeStr;

    if (hasDateAndTime) {
      const bookingDate = dateStringToUtcMidnight(dateStr);
      slot = await TimeSlot.findOne({ ...scope, startTime: timeStr });
      if (!slot) {
        return { success: false, error: "INVALID_TIME" };
      }

      const bookingsInSlot = await Booking.find({
        ...scope,
        date: bookingDate,
        timeSlot: slot._id,
        status: { $ne: "cancelado" },
      });

      const matching = matchBookingsByClient(
        {
          phone: normalizedClientPhone,
          whatsappId: clientWhatsappId,
          chatId: clientWhatsappId,
          canonicalClientPhone: normalizedClientPhone,
        },
        bookingsInSlot,
      );
      booking = matching.matchedBookings[0] || null;
    } else {
      const todayStr = getDatePartsInTimezone(new Date());
      const todayDate = dateStringToUtcMidnight(todayStr);
      const candidates = await Booking.find({
        ...scope,
        status: { $ne: "cancelado" },
        date: { $gte: todayDate },
      })
        .populate("timeSlot", "startTime")
        .sort({ date: -1, createdAt: -1 });

      const matching = matchBookingsByClient(
        {
          phone: normalizedClientPhone,
          whatsappId: clientWhatsappId,
          chatId: clientWhatsappId,
          canonicalClientPhone: normalizedClientPhone,
        },
        candidates,
      );
      booking = matching.matchedBookings[0] || null;
      if (booking?.timeSlot?.startTime) {
        resolvedDateStr = getDatePartsInTimezone(new Date(booking.date));
        resolvedTimeStr = String(booking.timeSlot.startTime || "");
      }
      if (booking?.timeSlot?._id) {
        slot = booking.timeSlot;
      }
    }

    if (!booking) {
      return { success: false, error: "NOT_FOUND" };
    }

    if (!slot?.startTime) {
      slot = await TimeSlot.findOne({ _id: booking.timeSlot, ...scope });
    }
    if (!resolvedDateStr) {
      resolvedDateStr = getDatePartsInTimezone(new Date(booking.date));
    }
    if (!resolvedTimeStr) {
      resolvedTimeStr = String(slot?.startTime || "");
    }

    const cancellationLockHours = await getCancellationLockHours(companyId);
    if (cancellationLockHours > 0) {
      const minutesUntilStart = getMinutesUntilSlotStart(resolvedDateStr, slot.startTime);
      const lockWindowMinutes = cancellationLockHours * 60;

      if (minutesUntilStart < lockWindowMinutes) {
        const contactPhone = await getCancellationContactPhone(companyId);
        return {
          success: false,
          error: "CANCELLATION_BLOCKED_WINDOW",
          data: {
            cancellationLockHours,
            minutesUntilStart,
            contactPhone,
          },
        };
      }
    }

    // 3. Cancelar
    booking.status = "cancelado";
    await booking.save();

    // 4. Penalizar al usuario
    const [PENALTY_LIMIT, PENALTY_SYSTEM_ENABLED] = await Promise.all([
      getPenaltyLimit(companyId),
      getPenaltySystemEnabled(companyId),
    ]);
    const user = await User.findOne({ ...scope, phoneNumber: normalizedClientPhone });
    let newPenalties = 0;
    let nowSuspended = false;
    let penaltyApplied = false;

    if (user) {
      if (PENALTY_SYSTEM_ENABLED) {
        user.penalties = (user.penalties || 0) + 1;
        newPenalties = user.penalties;
        if (user.penalties >= PENALTY_LIMIT) {
          user.isSuspended = true;
          nowSuspended = true;
        }
        penaltyApplied = true;
      } else {
        newPenalties = user.penalties || 0;
      }
      await user.save();
    }

    // 5. Notificar al admin
    const suspendedNote = nowSuspended ? " ⚠️ USUARIO SUSPENDIDO" : "";
    await sendAdminNotification(
      "booking_cancelled",
      `Turno Cancelado${suspendedNote}`,
      `Cliente: ${booking.clientName}\nTeléfono: ${normalizedClientPhone}\nFecha: ${formatBookingDateShort(booking.date)}\nHora: ${slot.startTime}\nPenalizaciones: ${PENALTY_SYSTEM_ENABLED ? `${newPenalties}/${PENALTY_LIMIT}` : "desactivadas"}`,
      { bookingId: booking._id, companyId },
      { companyId },
    );

    try {
      await enqueueWhatsappCommand({
        companyId,
        type: COMMAND_TYPES.NOTIFY_CANCELLATION_GROUP,
        payload: {
          booking: {
            date: booking?.date || null,
            timeSlot: {
              startTime: slot?.startTime || null,
            },
          },
          time: slot.startTime,
          cancelledBy: "cliente (WhatsApp)",
        },
      });
    } catch (groupError) {
      console.error(
        `[CancellationGroup][${companyId || "global"}] Error notificando cancelación desde WhatsApp:`,
        groupError?.message || groupError,
      );
    }

    return {
      success: true,
      nowSuspended,
      penaltyApplied,
      penaltyEnabled: PENALTY_SYSTEM_ENABLED,
      penaltySystemEnabled: PENALTY_SYSTEM_ENABLED,
      penalties: newPenalties,
      penaltyLimit: PENALTY_LIMIT,
      data: {
        clientName: booking.clientName,
        date: resolvedDateStr,
        time: slot.startTime,
      },
    };
  } catch (error) {
    console.error("Error cancelBooking:", error);
    return { success: false, error: "INTERNAL_ERROR" };
  }
};

module.exports = {
  createNewBooking,
  getAvailableSlots,
  cancelBooking,
  hasActiveBookingForClient,
  getActiveBookingsForClient,
};

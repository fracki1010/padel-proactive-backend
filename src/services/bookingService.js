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
const TIMEZONE = "America/Argentina/Buenos_Aires";
const DAILY_BOOKING_LIMIT_PER_CLIENT = Number(
  process.env.DAILY_BOOKING_LIMIT_PER_CLIENT || 6,
);
const buildCompanyFilter = (companyId = null) => ({ companyId: companyId || null });
const normalizeWhatsappId = (value = "") => String(value || "").trim().toLowerCase();
const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const whatsappIdsMatch = (bookingWhatsappId = "", requestWhatsappId = "") => {
  const booking = normalizeWhatsappId(bookingWhatsappId);
  const request = normalizeWhatsappId(requestWhatsappId);
  if (!booking || !request) return false;
  return booking === request;
};

const phonesMatch = (bookingPhoneRaw = "", requestPhoneRaw = "") => {
  // 1) Comparación literal tal cual llega/está guardado.
  if (bookingPhoneRaw === requestPhoneRaw) return true;
  if (String(bookingPhoneRaw) === String(requestPhoneRaw)) return true;

  // 2) Comparación numérica equivalente (por si uno llega number y el otro string).
  const bookingNumber = Number(bookingPhoneRaw);
  const requestNumber = Number(requestPhoneRaw);
  if (Number.isFinite(bookingNumber) && Number.isFinite(requestNumber)) {
    return bookingNumber === requestNumber;
  }

  return false;
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
    // 0. Verificar si el usuario está suspendido
    const user = await User.findOne({ ...scope, phoneNumber: clientPhone });
    if (user && user.isSuspended) {
      return { success: false, error: "SUSPENDED" };
    }
    const bookingDate = dateStringToUtcMidnight(dateStr);

    if (hasSlotStarted(dateStr, timeStr)) {
      return { success: false, error: "PAST_TIME" };
    }

    // 2. Buscar el TimeSlot correspondiente (Ej: "20:00")
    const slot = await TimeSlot.findOne({ ...scope, startTime: timeStr });
    if (!slot) {
      return { success: false, error: "INVALID_TIME" }; // "Ese horario no existe"
    }

    // 2.0 Límite diario por cliente: máximo 3 reservas activas por día
    const clientDailyBookingsCount = await Booking.countDocuments({
      ...scope,
      clientPhone,
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
      const existingClientBooking = await Booking.findOne({
        ...scope,
        clientPhone,
        date: bookingDate,
        timeSlot: slot._id,
        status: { $ne: "cancelado" },
      });

      if (existingClientBooking) {
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

    // CASO A: AL USUARIO LE DA IGUAL ("INDIFERENTE")
    // La IA manda "INDIFERENTE" cuando sabe que las canchas son iguales
    if (courtName === "INDIFERENTE") {
      // a) Buscamos TODAS las canchas activas
      const allCourts = await Court.find({ ...scope, isActive: true });

      // b) Buscamos qué canchas están ocupadas en ese horario exacto
      const busyBookings = await Booking.find({
        ...scope,
        date: bookingDate,
        timeSlot: slot._id,
        status: { $ne: "cancelado" },
      });

      // Array de IDs de canchas ocupadas
      const busyCourtIds = busyBookings.map((b) => b.court.toString());

      // c) Filtramos: Nos quedamos con la primera que NO esté en la lista de ocupadas
      selectedCourt = allCourts.find(
        (c) => !busyCourtIds.includes(c._id.toString()),
      );

      // Si no quedó ninguna, es que está todo lleno
      if (!selectedCourt) {
        return { success: false, error: "BUSY" };
      }
    }
    // CASO B: EL USUARIO ELIGIÓ UNA ESPECÍFICA (Ej: "Cancha 1" o "Techada")
    else {
      const escapedCourtName = escapeRegex(courtName);
      // a) Buscamos esa cancha específica
      selectedCourt = await Court.findOne({
        ...scope,
        name: { $regex: new RegExp(`^${escapedCourtName}$`, "i") },
      });

      if (!selectedCourt) {
        // Intento fallback: Búsqueda parcial por si dijo "la 1" en vez de "Cancha 1"
        selectedCourt = await Court.findOne({
          ...scope,
          name: { $regex: escapedCourtName, $options: "i" },
        });
        if (!selectedCourt)
          return { success: false, error: "CANCHA_NOT_FOUND" };
      }

      // b) Verificamos si ESA cancha puntual está ocupada
      const existingBooking = await Booking.findOne({
        ...scope,
        court: selectedCourt._id,
        date: bookingDate,
        timeSlot: slot._id,
        status: { $ne: "cancelado" },
      });

      if (existingBooking) {
        return { success: false, error: "BUSY" };
      }
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
      clientPhone,
      clientWhatsappId: normalizeWhatsappId(clientWhatsappId) || null,
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
      .select("clientPhone clientWhatsappId")
      .limit(200)
      .lean();

    const existing = candidates.find(
      (booking) =>
        whatsappIdsMatch(booking?.clientWhatsappId, clientWhatsappId) ||
        phonesMatch(booking?.clientPhone, clientPhone),
    );

    return Boolean(existing);
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
    const debugPrefix = `[BookingsLookup][${companyId || "global"}]`;

    console.log(
      `${debugPrefix} request clientPhone=${String(clientPhone)} clientWhatsappId=${String(clientWhatsappId || "")} today=${todayStr}`,
    );

    const bookings = await Booking.find({
      ...scope,
      status: { $ne: "cancelado" },
      date: { $gte: todayDate },
    })
      .populate("court", "name")
      .populate("timeSlot", "startTime endTime")
      .sort({ date: 1, createdAt: 1 })
      .lean();

    console.log(`${debugPrefix} candidates=${bookings.length}`);

    const matchingByClient = bookings.filter(
      (booking) =>
        whatsappIdsMatch(booking?.clientWhatsappId, clientWhatsappId) ||
        phonesMatch(booking?.clientPhone, clientPhone),
    );

    const sampleAudit = bookings.slice(0, 25).map((booking) => {
      const byWhatsapp = whatsappIdsMatch(
        booking?.clientWhatsappId,
        clientWhatsappId,
      );
      const byPhone = phonesMatch(booking?.clientPhone, clientPhone);
      return {
        bookingId: String(booking?._id || ""),
        bookingPhone: String(booking?.clientPhone || ""),
        bookingWhatsappId: String(booking?.clientWhatsappId || ""),
        byWhatsapp,
        byPhone,
        matched: byWhatsapp || byPhone,
        date: booking?.date ? new Date(booking.date).toISOString().slice(0, 10) : "",
        startTime: String(booking?.timeSlot?.startTime || ""),
        status: String(booking?.status || ""),
      };
    });
    console.log(`${debugPrefix} sampleAudit=`, sampleAudit);
    console.log(`${debugPrefix} matchedByClient=${matchingByClient.length}`);

    // "Reservas vigentes" = reservas activas desde hoy en adelante.
    // No excluimos turnos de hoy que ya empezaron.
    const activeCurrentAndFuture = matchingByClient.filter((booking) =>
      Boolean(booking?.timeSlot?.startTime),
    );
    console.log(`${debugPrefix} activeCurrentAndFuture=${activeCurrentAndFuture.length}`);

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
    console.log(`${debugPrefix} returning=${sortedUpcoming.length}`);

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

    return {
      success: true,
      date: dateStr,
      slots: availableSlots.map((s) => ({ time: s.startTime, price: s.price })),
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
  dateStr,
  timeStr,
}) => {
  try {
    const scope = buildCompanyFilter(companyId);
    const bookingDate = dateStringToUtcMidnight(dateStr);

    // 1. Buscar el slot por hora
    const slot = await TimeSlot.findOne({ ...scope, startTime: timeStr });
    if (!slot) {
      return { success: false, error: "INVALID_TIME" };
    }

    // 2. Buscar la reserva activa del cliente en esa fecha y hora
    const bookingsInSlot = await Booking.find({
      ...scope,
      date: bookingDate,
      timeSlot: slot._id,
      status: { $ne: "cancelado" },
    });

    const booking = bookingsInSlot.find(
      (item) =>
        whatsappIdsMatch(item?.clientWhatsappId, clientWhatsappId) ||
        phonesMatch(item?.clientPhone, clientPhone),
    );

    if (!booking) {
      return { success: false, error: "NOT_FOUND" };
    }

    const cancellationLockHours = await getCancellationLockHours(companyId);
    if (cancellationLockHours > 0) {
      const minutesUntilStart = getMinutesUntilSlotStart(dateStr, slot.startTime);
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
    const user = await User.findOne({ ...scope, phoneNumber: clientPhone });
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
      `Cliente: ${booking.clientName}\nTeléfono: ${clientPhone}\nFecha: ${formatBookingDateShort(booking.date)}\nHora: ${slot.startTime}\nPenalizaciones: ${PENALTY_SYSTEM_ENABLED ? `${newPenalties}/${PENALTY_LIMIT}` : "desactivadas"}`,
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
        date: dateStr,
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

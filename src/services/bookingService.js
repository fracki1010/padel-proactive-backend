// src/services/bookingService.js
const Booking = require("../models/booking.model");
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const User = require("../models/user.model");
const { sendAdminNotification } = require("./notificationService");
const { formatBookingDateShort } = require("../utils/formatBookingDateShort");
const { getPenaltyLimit } = require("./appConfig.service");
const TIMEZONE = "America/Argentina/Buenos_Aires";
const buildCompanyFilter = (companyId = null) => ({ companyId: companyId || null });

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
      // a) Buscamos esa cancha específica
      selectedCourt = await Court.findOne({
        ...scope,
        name: { $regex: new RegExp(`^${courtName}$`, "i") },
      });

      if (!selectedCourt) {
        // Intento fallback: Búsqueda parcial por si dijo "la 1" en vez de "Cancha 1"
        selectedCourt = await Court.findOne({
          ...scope,
          name: { $regex: courtName, $options: "i" },
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
const cancelBooking = async ({ companyId = null, clientPhone, dateStr, timeStr }) => {
  try {
    const scope = buildCompanyFilter(companyId);
    const bookingDate = dateStringToUtcMidnight(dateStr);

    // 1. Buscar el slot por hora
    const slot = await TimeSlot.findOne({ ...scope, startTime: timeStr });
    if (!slot) {
      return { success: false, error: "INVALID_TIME" };
    }

    // 2. Buscar la reserva activa del cliente en esa fecha y hora
    const booking = await Booking.findOne({
      ...scope,
      clientPhone,
      date: bookingDate,
      timeSlot: slot._id,
      status: { $ne: "cancelado" },
    });

    if (!booking) {
      return { success: false, error: "NOT_FOUND" };
    }

    // 3. Cancelar
    booking.status = "cancelado";
    await booking.save();

    // 4. Penalizar al usuario
    const PENALTY_LIMIT = await getPenaltyLimit(companyId);
    const user = await User.findOne({ ...scope, phoneNumber: clientPhone });
    let newPenalties = 0;
    let nowSuspended = false;

    if (user) {
      user.penalties = (user.penalties || 0) + 1;
      newPenalties = user.penalties;
      if (user.penalties >= PENALTY_LIMIT) {
        user.isSuspended = true;
        nowSuspended = true;
      }
      await user.save();
    }

    // 5. Notificar al admin
    const suspendedNote = nowSuspended ? " ⚠️ USUARIO SUSPENDIDO" : "";
    await sendAdminNotification(
      "booking_cancelled",
      `Turno Cancelado${suspendedNote}`,
      `Cliente: ${booking.clientName}\nTeléfono: ${clientPhone}\nFecha: ${formatBookingDateShort(booking.date)}\nHora: ${slot.startTime}\nPenalizaciones: ${newPenalties}/${PENALTY_LIMIT}`,
      { bookingId: booking._id, companyId },
      { companyId },
    );

    return {
      success: true,
      nowSuspended,
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

module.exports = { createNewBooking, getAvailableSlots, cancelBooking };

// src/services/bookingService.js
const Booking = require("../models/booking.model");
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const User = require("../models/user.model");
const { sendAdminNotification } = require("./notificationService");

/**
 * Crea una nueva reserva.
 * Soporta selección automática ("INDIFERENTE") o específica de cancha.
 */
const createNewBooking = async ({
  courtName,
  dateStr,
  timeStr,
  clientName,
  clientPhone,
}) => {
  try {
    // 0. Verificar si el usuario está suspendido
    const user = await User.findOne({ phoneNumber: clientPhone });
    if (user && user.isSuspended) {
      return { success: false, error: "SUSPENDED" };
    }
    const bookingDate = new Date(dateStr);
    bookingDate.setUTCHours(0, 0, 0, 0);

    // 2. Buscar el TimeSlot correspondiente (Ej: "20:00")
    const slot = await TimeSlot.findOne({ startTime: timeStr });
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
      const allCourts = await Court.find({ isActive: true });

      // b) Buscamos qué canchas están ocupadas en ese horario exacto
      const busyBookings = await Booking.find({
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
        name: { $regex: new RegExp(`^${courtName}$`, "i") },
      });

      if (!selectedCourt) {
        // Intento fallback: Búsqueda parcial por si dijo "la 1" en vez de "Cancha 1"
        selectedCourt = await Court.findOne({
          name: { $regex: courtName, $options: "i" },
        });
        if (!selectedCourt)
          return { success: false, error: "CANCHA_NOT_FOUND" };
      }

      // b) Verificamos si ESA cancha puntual está ocupada
      const existingBooking = await Booking.findOne({
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
      `Cliente: ${newBooking.clientName}\nFecha: ${newBooking.date.toLocaleDateString()}\nHora: ${slot.startTime}\nCancha: ${selectedCourt.name}`,
      { bookingId: newBooking._id },
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
const getAvailableSlots = async (dateStr) => {
  try {
    const TIMEZONE = "America/Argentina/Buenos_Aires"; // Ajusta a tu zona

    // 1. Normalizar fecha
    const queryDate = new Date(dateStr);
    queryDate.setUTCHours(0, 0, 0, 0);

    // 2. Lógica de "HOY" para ocultar horarios pasados
    const nowString = new Date().toLocaleString("en-US", {
      timeZone: TIMEZONE,
    });
    const nowObj = new Date(nowString);

    // Validamos si la fecha solicitada es HOY comparando strings YYYY-MM-DD
    const isToday =
      queryDate.toISOString().split("T")[0] ===
      new Date(nowObj).toISOString().split("T")[0]; // Simple y efectivo si queryDate viene de un string ISO

    // 3. Traer datos maestros
    const allSlots = await TimeSlot.find({ isActive: true }).sort({ order: 1 });
    const totalCourtsCount = await Court.countDocuments({ isActive: true });

    // 4. Traer reservas
    const bookings = await Booking.find({
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
        const [slotHour, slotMin] = slot.startTime.split(":").map(Number);
        const slotTotalMinutes = slotHour * 60 + slotMin;

        const currentHour = nowObj.getHours();
        const currentMin = nowObj.getMinutes();
        const currentTotalMinutes = currentHour * 60 + currentMin;

        // Si el turno ya pasó o empieza en menos de 15 minutos, lo ocultamos
        if (slotTotalMinutes <= currentTotalMinutes + 15) {
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
const cancelBooking = async ({ clientPhone, dateStr, timeStr }) => {
  try {
    const bookingDate = new Date(dateStr);
    bookingDate.setUTCHours(0, 0, 0, 0);

    // 1. Buscar el slot por hora
    const slot = await TimeSlot.findOne({ startTime: timeStr });
    if (!slot) {
      return { success: false, error: "INVALID_TIME" };
    }

    // 2. Buscar la reserva activa del cliente en esa fecha y hora
    const booking = await Booking.findOne({
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
    const PENALTY_LIMIT = 2;
    const user = await User.findOne({ phoneNumber: clientPhone });
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
      `Cliente: ${booking.clientName}\nTeléfono: ${clientPhone}\nFecha: ${booking.date.toLocaleDateString()}\nHora: ${slot.startTime}\nPenalizaciones: ${newPenalties}/${PENALTY_LIMIT}`,
      { bookingId: booking._id },
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

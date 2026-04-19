const Booking = require("../models/booking.model");
const TimeSlot = require("../models/timeSlot.model");
const Court = require("../models/court.model");
const mongoose = require("mongoose");
const { sendAdminNotification } = require("../services/notificationService");
const { formatBookingDateShort } = require("../utils/formatBookingDateShort");
const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require("../services/whatsappCommandQueue.service");
const { getPenaltyLimit } = require("../services/appConfig.service");
const {
  materializeFixedBookingsForDate,
  materializeFixedBookingsInRange,
} = require("../services/fixedTurnsMaterialization.service");
const {
  normalizeCanonicalClientPhone,
} = require("../utils/identityNormalization");
const DAILY_BOOKING_LIMIT_PER_CLIENT = Number(
  process.env.DAILY_BOOKING_LIMIT_PER_CLIENT || 6,
);

const normalizePhoneToChatId = (rawPhone = "") => {
  const digits = normalizeCanonicalClientPhone(rawPhone);
  if (!digits) return "";
  return `${digits}@c.us`;
};

const toIsoDateOnly = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toISOString().slice(0, 10);
};

const resolveCompanyId = (req) => {
  if (req.user?.role === "super_admin") {
    return req.query.companyId || req.body.companyId || null;
  }
  return req.user?.companyId || null;
};

const companyScope = (req, companyId) => {
  if (req.user?.role === "super_admin") {
    return companyId ? { companyId } : {};
  }
  return { companyId: req.user?.companyId || null };
};

const parseDateToUtcMidnight = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCHours(0, 0, 0, 0);
  return parsed;
};

// 1. OBTENER RESERVAS (GET)
const getBookings = async (req, res) => {
  try {
    const { date } = req.query;
    const companyId = resolveCompanyId(req);
    let query = companyScope(req, companyId);
    let searchDate = new Date();

    if (date) {
      searchDate = new Date(date);
      searchDate.setUTCHours(0, 0, 0, 0);
      query.date = searchDate;
    }

    if (date) {
      const fixedTurnsCompanyId =
        req.user?.role === "super_admin" && !companyId ? undefined : companyId;
      await materializeFixedBookingsForDate({
        companyId: fixedTurnsCompanyId,
        searchDate,
      });
    }

    // A. Obtener reservas
    const bookings = await Booking.find(query)
      .populate("timeSlot")
      .populate("court")
      .sort({ date: -1, createdAt: -1 });

    // Ordenar manualmente por el campo 'order' del timeSlot
    bookings.sort((a, b) => {
      const orderA = a.timeSlot?.order || 0;
      const orderB = b.timeSlot?.order || 0;
      return orderA - orderB;
    });

    const normalizedBookings = bookings.map((booking) => ({
      ...(typeof booking.toObject === "function" ? booking.toObject() : booking),
      date: toIsoDateOnly(booking.date),
    }));

    res.status(200).json({
      success: true,
      count: normalizedBookings.length,
      data: normalizedBookings,
    });
  } catch (error) {
    console.error("Error en getBookings:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// 2. CREAR RESERVA (POST)
const createBooking = async (req, res) => {
  try {
    const {
      courtId,
      date,
      time,
      slotId,
      clientName,
      clientPhone,
      paymentStatus,
      status,
      finalPrice,
    } = req.body;
    const companyId = resolveCompanyId(req);

    // A. Validaciones básicas
    if (!courtId || !date || (!time && !slotId)) {
      return res.status(400).json({
        success: false,
        error: "Faltan datos: courtId, date, y (time o slotId)",
      });
    }

    const courtExists = await Court.exists({
      _id: courtId,
      ...companyScope(req, companyId),
    });
    if (!courtExists) {
      return res
        .status(404)
        .json({ success: false, error: "Cancha no encontrada" });
    }

    // B. Buscar el TimeSlot
    let slot;
    const tenantSlotFilter = companyScope(req, companyId);
    if (slotId) {
      slot = await TimeSlot.findOne({ _id: slotId, ...tenantSlotFilter });
    } else {
      slot = await TimeSlot.findOne({ startTime: time, ...tenantSlotFilter });
    }

    if (!slot) {
      return res
        .status(400)
        .json({ success: false, error: "Horario no válido o inexistente" });
    }

    // C. Preparar fecha exacta
    const bookingDate = new Date(date);
    bookingDate.setUTCHours(0, 0, 0, 0);

    const fixedTurnsCompanyId =
      req.user?.role === "super_admin" && !companyId ? undefined : companyId;
    await materializeFixedBookingsForDate({
      companyId: fixedTurnsCompanyId,
      searchDate: bookingDate,
    });

    const normalizedClientPhone = normalizeCanonicalClientPhone(clientPhone);
    const isMaintenanceBooking =
      normalizedClientPhone === "" || normalizedClientPhone === "MANTENIMIENTO";

    // C.1 Límite diario: máximo 3 reservas activas por cliente
    if (!isMaintenanceBooking && status !== "suspendido") {
      const dailyBookingsCount = await Booking.countDocuments({
        ...companyScope(req, companyId),
        clientPhone: normalizedClientPhone,
        date: bookingDate,
        status: { $ne: "cancelado" },
      });

      if (dailyBookingsCount >= DAILY_BOOKING_LIMIT_PER_CLIENT) {
        return res.status(409).json({
          success: false,
          error: `Este cliente ya tiene ${DAILY_BOOKING_LIMIT_PER_CLIENT} reservas activas para ese día.`,
        });
      }
    }

    // D. Validar Disponibilidad
    const existingBooking = await Booking.findOne({
      ...companyScope(req, companyId),
      court: courtId,
      date: bookingDate,
      timeSlot: slot._id,
      status: { $ne: "cancelado" },
    });

    if (existingBooking) {
      return res.status(409).json({
        success: false,
        error: "Este turno ya tiene una actividad (reserva o suspensión).",
      });
    }

    // E. Crear
    const newBooking = await Booking.create({
      companyId,
      court: courtId,
      date: bookingDate,
      timeSlot: slot._id,
      clientName: clientName || "SISTEMA",
      clientPhone: clientPhone || "MANTENIMIENTO",
      finalPrice: finalPrice !== undefined ? finalPrice : slot.price,
      status: status || "confirmado",
      paymentStatus: paymentStatus || "pagado",
    });

    await newBooking.populate(["court", "timeSlot"]);

    // Notificar al admin
    if (newBooking.status !== "suspendido") {
      await sendAdminNotification(
        "new_booking",
        "Nuevo Turno Reservado",
        `Cliente: ${newBooking.clientName}\nFecha: ${formatBookingDateShort(newBooking.date)}\nHora: ${newBooking.timeSlot.startTime}\nCancha: ${newBooking.court.name}`,
        { bookingId: newBooking._id, companyId },
        { companyId },
      );
    }

    const bookingPhone = String(newBooking.clientPhone || "").trim();
    const bookingChatId = normalizePhoneToChatId(bookingPhone);
    const isBookableClientPhone =
      bookingPhone &&
      bookingPhone.toUpperCase() !== "MANTENIMIENTO" &&
      Boolean(bookingChatId);

    if (newBooking.status !== "suspendido" && isBookableClientPhone) {
      const clientMessage =
        `Hola ${newBooking.clientName}, tu turno ya quedó reservado.\n` +
        `Fecha: ${formatBookingDateShort(newBooking.date)}\n` +
        `Hora: ${newBooking.timeSlot.startTime}\n` +
        `Cancha: ${newBooking.court.name}`;

      try {
        await enqueueWhatsappCommand({
          companyId,
          type: COMMAND_TYPES.SEND_MESSAGE,
          payload: {
            to: bookingChatId,
            message: clientMessage,
          },
          requestedBy: req.user?._id || null,
        });
      } catch (clientNotificationError) {
        console.error(
          `[BookingController][${companyId || "global"}] Error notificando reserva al cliente:`,
          clientNotificationError?.message || clientNotificationError,
        );
      }
    }

    res.status(201).json({
      success: true,
      data: newBooking,
    });
  } catch (error) {
    console.error("Error en createBooking:", error);
    if (error.code === 11000) {
      return res
        .status(409)
        .json({ success: false, error: "Este turno ya está ocupado." });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};

// 3. ELIMINAR RESERVA (DELETE)
const deleteBooking = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const booking = await Booking.findOneAndDelete({
      _id: req.params.id,
      ...companyScope(req, companyId),
    });
    if (!booking) {
      return res
        .status(404)
        .json({ success: false, error: "Reserva no encontrada" });
    }
    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    console.error("Error en deleteBooking:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// 4. ACTUALIZAR RESERVA (PUT)
const updateBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const companyId = resolveCompanyId(req);
    const scope = companyScope(req, companyId);
    console.log(`Actualizando reserva ${id}:`, req.body);

    const previousBooking = await Booking.findOne({ _id: id, ...scope }).populate([
      "court",
      "timeSlot",
    ]);
    if (!previousBooking) {
      return res
        .status(404)
        .json({ success: false, error: "Reserva no encontrada" });
    }

    // Limpiar campos que no deben actualizarse directamente o que darían error
    const updateData = { ...req.body };
    const applyPenalty = req.body?.applyPenalty === true;
    delete updateData._id;
    delete updateData.id;
    delete updateData.createdAt;
    delete updateData.updatedAt;
    delete updateData.__v;
    delete updateData.applyPenalty;

    const updatedBooking = await Booking.findOneAndUpdate(
      { _id: id, ...scope },
      { $set: updateData },
      { returnDocument: "after", runValidators: true },
    ).populate(["court", "timeSlot"]);

    const wasCancelledBefore = previousBooking.status === "cancelado";
    const isCancelledNow = updatedBooking.status === "cancelado";
    const shouldNotifyCancellation = !wasCancelledBefore && isCancelledNow;
    const penaltyResult = {
      requested: applyPenalty,
      attempted: false,
      applied: false,
      userFound: false,
      penalties: null,
      penaltyLimit: null,
      isSuspended: false,
      suspendedNow: false,
    };

    if (shouldNotifyCancellation) {
      if (applyPenalty) {
        penaltyResult.attempted = true;
        const bookingPhone = String(updatedBooking.clientPhone || "").trim();
        const user = await User.findOne({
          ...scope,
          phoneNumber: bookingPhone,
        });

        if (user) {
          const penaltyLimit = await getPenaltyLimit(companyId);
          const previousPenalties = Number(user.penalties || 0);
          const wasSuspended = Boolean(user.isSuspended);
          user.penalties = previousPenalties + 1;
          penaltyResult.userFound = true;
          penaltyResult.applied = true;
          penaltyResult.penalties = user.penalties;
          penaltyResult.penaltyLimit = penaltyLimit;

          if (user.penalties >= penaltyLimit) {
            user.isSuspended = true;
          }

          penaltyResult.isSuspended = Boolean(user.isSuspended);
          penaltyResult.suspendedNow = !wasSuspended && Boolean(user.isSuspended);

          await user.save();
        }
      }

      const penaltyMessage = penaltyResult.attempted
        ? penaltyResult.applied
          ? `\nPenalización: aplicada (${penaltyResult.penalties}/${penaltyResult.penaltyLimit})`
          : "\nPenalización: no aplicada (usuario no encontrado)"
        : "\nPenalización: no";

      try {
        await sendAdminNotification(
          "booking_cancelled",
          "Turno Cancelado (Panel)",
          `Cliente: ${updatedBooking.clientName}\nFecha: ${formatBookingDateShort(updatedBooking.date)}\nHora: ${updatedBooking?.timeSlot?.startTime || "N/D"}\nCancha: ${updatedBooking?.court?.name || "N/D"}${penaltyMessage}`,
          { bookingId: updatedBooking._id, companyId },
          { companyId },
        );
      } catch (adminNotificationError) {
        console.error(
          `[BookingController][${companyId || "global"}] Error notificando cancelación al admin:`,
          adminNotificationError?.message || adminNotificationError,
        );
      }

      try {
        await enqueueWhatsappCommand({
          companyId,
          type: COMMAND_TYPES.NOTIFY_CANCELLATION_GROUP,
          payload: {
            booking: {
              date: updatedBooking?.date || null,
              timeSlot: {
                startTime: updatedBooking?.timeSlot?.startTime || null,
              },
              court: {
                name: updatedBooking?.court?.name || null,
              },
            },
            time: updatedBooking?.timeSlot?.startTime || null,
            courtName: updatedBooking?.court?.name || null,
            cancelledBy: "administración",
          },
          requestedBy: req.user?._id || null,
        });
      } catch (groupError) {
        console.error(
          `[CancellationGroup][${companyId || "global"}] Error notificando cancelación desde panel:`,
          groupError?.message || groupError,
        );
      }
    }

    res.status(200).json({ success: true, data: updatedBooking, penalty: penaltyResult });
  } catch (error) {
    console.error("Error en updateBooking:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

const rematerializeFixedTurns = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const payload = req.body || {};
    const fromDateRaw = payload.fromDate || req.query.fromDate;
    const daysAheadRaw = payload.daysAhead ?? req.query.daysAhead;
    const userIdRaw = payload.userId || req.query.userId || null;

    const fromDate = fromDateRaw ? parseDateToUtcMidnight(fromDateRaw) : new Date();
    if (fromDateRaw && !fromDate) {
      return res.status(400).json({
        success: false,
        error: "fromDate inválida. Usá formato YYYY-MM-DD.",
      });
    }

    const parsedDaysAhead =
      daysAheadRaw === undefined ? undefined : Number(daysAheadRaw);
    if (
      parsedDaysAhead !== undefined &&
      (!Number.isInteger(parsedDaysAhead) ||
        parsedDaysAhead < 0 ||
        parsedDaysAhead > 365)
    ) {
      return res.status(400).json({
        success: false,
        error: "daysAhead inválido. Debe ser un entero entre 0 y 365.",
      });
    }

    const userId = userIdRaw ? String(userIdRaw).trim() : null;
    if (userId && !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: "userId inválido.",
      });
    }

    const fixedTurnsCompanyId =
      req.user?.role === "super_admin" && !companyId ? undefined : companyId;

    const result = await materializeFixedBookingsInRange({
      companyId: fixedTurnsCompanyId,
      fromDate: fromDate || new Date(),
      ...(parsedDaysAhead !== undefined ? { daysAhead: parsedDaysAhead } : {}),
      ...(userId ? { userId } : {}),
    });

    return res.status(200).json({
      success: true,
      data: {
        companyId: fixedTurnsCompanyId ?? "all",
        fromDate: toIsoDateOnly(fromDate || new Date()),
        daysAhead: parsedDaysAhead !== undefined ? parsedDaysAhead : 90,
        userId: userId || null,
        createdCount: Number(result?.createdCount || 0),
        skippedCount: Number(result?.skippedCount || 0),
        datesProcessed: Number(result?.datesProcessed || 0),
      },
    });
  } catch (error) {
    console.error("Error en rematerializeFixedTurns:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  getBookings,
  createBooking,
  deleteBooking,
  updateBooking,
  rematerializeFixedTurns,
};

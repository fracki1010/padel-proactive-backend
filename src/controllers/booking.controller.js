const Booking = require("../models/booking.model");
const TimeSlot = require("../models/timeSlot.model");
const Court = require("../models/court.model");
const User = require("../models/user.model");
const { sendAdminNotification } = require("../services/notificationService");
const { formatBookingDateShort } = require("../utils/formatBookingDateShort");
const { notifyCancellationToGroup } = require("../services/whatsappCancellationGroup.service");
const { getPenaltyLimit } = require("../services/appConfig.service");
const DAILY_BOOKING_LIMIT_PER_CLIENT = Number(
  process.env.DAILY_BOOKING_LIMIT_PER_CLIENT || 6,
);
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

    // A. Obtener reservas reales
    const bookings = await Booking.find(query)
      .populate("timeSlot")
      .populate("court")
      .sort({ date: -1, createdAt: -1 });

    // B. Obtener turnos fijos si se buscó por una fecha específica
    if (date) {
      const dayOfWeek = searchDate.getUTCDay(); // 0-6 (Dom-Sab)

      const usersWithFixedTurns = await User.find({
        ...companyScope(req, companyId),
        "fixedTurns.dayOfWeek": dayOfWeek,
      })
        .populate("fixedTurns.timeSlot")
        .populate("fixedTurns.court");

      usersWithFixedTurns.forEach((user) => {
        user.fixedTurns.forEach((ft) => {
          if (ft.dayOfWeek === dayOfWeek) {
            // Verificar si ya hay una reserva real para esta cancha y slot en esta fecha
            const hasRealBooking = bookings.some((b) => {
              const isSameSlotAndCourt =
                b.court?._id?.toString() === ft.court?._id?.toString() &&
                b.timeSlot?._id?.toString() === ft.timeSlot?._id?.toString();

              if (!isSameSlotAndCourt) return false;

              // Si hay una reserva real ACTIVA (no cancelada), la respetamos y no creamos la virtual.
              if (b.status !== "cancelado") return true;

              // Si hay una reserva CANCELADA, pero es del mismo usuario del turno fijo,
              // significa que el usuario canceló SU turno fijo para este día.
              // Por lo tanto, no recreamos el turno virtual.
              if (
                b.status === "cancelado" &&
                b.clientPhone === user.phoneNumber
              ) {
                return true;
              }

              return false;
            });

            if (!hasRealBooking) {
              // Crear reserva "virtual"
              // Le ponemos un ID especial o simplemente no le ponemos ID de DB
              bookings.push({
                _id: `fixed-${user._id}-${ft.court._id}-${ft.timeSlot._id}`,
                court: ft.court,
                timeSlot: ft.timeSlot,
                date: searchDate,
                clientName: user.name,
                clientPhone: user.phoneNumber,
                status: "confirmado",
                paymentStatus: "pendiente",
                isFixed: true, // Flag para el frontend
                finalPrice: ft.timeSlot.price || 0,
              });
            }
          }
        });
      });
    }

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

    const normalizedClientPhone = String(clientPhone || "").trim();
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
      { new: true, runValidators: true },
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
        await notifyCancellationToGroup({
          companyId,
          booking: updatedBooking,
          cancelledBy: "administración",
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

module.exports = {
  getBookings,
  createBooking,
  deleteBooking,
  updateBooking,
};

const express = require("express");
const router = express.Router();
const Booking = require("../models/booking.model");
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const User = require("../models/user.model");
const {
  setWhatsappEnabledConfigOnly,
} = require("../services/whatsappControl.service");
const {
  getWhatsappRuntimeState,
} = require("../services/whatsappRuntimeState.service");
const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require("../services/whatsappCommandQueue.service");
const {
  DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES,
  DEFAULT_ATTENDANCE_RESPONSE_TIMEOUT_MINUTES,
  DEFAULT_CANCELLATION_LOCK_HOURS,
  DEFAULT_DAILY_AVAILABILITY_DIGEST_HOUR,
  DEFAULT_PENALTY_LIMIT,
  DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT,
  getAttendanceReminderLeadMinutes,
  getAttendanceResponseTimeoutMinutes,
  getCancellationLockHours,
  getOneHourReminderEnabled,
  getPenaltyLimit,
  getPenaltySystemEnabled,
  getStrictQuestionFlowEnabled,
  getTrustedClientConfirmationCount,
  setAttendanceReminderLeadMinutes,
  setAttendanceResponseTimeoutMinutes,
  setCancellationLockHours,
  setPenaltyLimit,
  setPenaltySystemEnabled,
  setStrictQuestionFlowEnabled,
  setOneHourReminderEnabled,
  setTrustedClientConfirmationCount,
  getWhatsappCancellationGroupSettings,
  setWhatsappCancellationGroupSettings,
  setDailyAvailabilityDigestStatus,
} = require("../services/appConfig.service");
const {
  getWhatsappGroupsSnapshot,
} = require("../services/whatsappGroupsSnapshot.service");
const {
  DEFAULT_SERVICE_NAME,
  getWorkerHealth,
} = require("../services/workerHeartbeat.service");
const DAILY_HOUR_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const resolveCompanyId = (req) => {
  if (req.user?.role === "super_admin") {
    return req.query.companyId || req.body.companyId || null;
  }
  return req.user?.companyId || null;
};
const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const companyScope = (req, companyId) => {
  if (req.user?.role === "super_admin") {
    return companyId ? { companyId } : {};
  }
  return { companyId: req.user?.companyId || null };
};

const firstBoolean = (values = []) => values.find((value) => typeof value === "boolean");
const firstString = (values = []) =>
  values.find((value) => typeof value === "string" && value.trim().length >= 0);

const buildWhatsappConfigResponse = async (companyId) => {
  const [state, cancellationGroup, oneHourReminderEnabled, workerHealth] =
    await Promise.all([
      getWhatsappRuntimeState(companyId),
      getWhatsappCancellationGroupSettings(companyId),
      getOneHourReminderEnabled(companyId),
      getWorkerHealth({ serviceName: DEFAULT_SERVICE_NAME }),
    ]);

  return {
    ...state,
    workerOnline: Boolean(workerHealth.online),
    workerHeartbeatAt: workerHealth.heartbeatAt,
    workerId: workerHealth.workerId,
    workerStaleAfterMs: workerHealth.staleAfterMs,
    oneHourReminderEnabled,
    oneHourBeforeEnabled: oneHourReminderEnabled,
    bookingReminderOneHourEnabled: oneHourReminderEnabled,
    notifyOneHourBeforeMatch: oneHourReminderEnabled,
    notifyOneHourBeforeBooking: oneHourReminderEnabled,
    cancellationGroupEnabled: cancellationGroup.enabled,
    cancellationGroupId: cancellationGroup.groupId,
    cancellationGroupName: cancellationGroup.groupName,
    dailyAvailabilityDigestEnabled:
      cancellationGroup.dailyAvailabilityDigestEnabled,
    dailyAvailabilityDigestHour: cancellationGroup.dailyAvailabilityDigestHour,
    dailyGroupAvailabilityHour: cancellationGroup.dailyAvailabilityDigestHour,
    groupDailyAvailabilityDigestHour: cancellationGroup.dailyAvailabilityDigestHour,
  };
};

const buildBotAutomationConfigResponse = async (companyId) => {
  const [
    oneHourReminderEnabled,
    attendanceReminderLeadMinutes,
    attendanceResponseTimeoutMinutes,
    cancellationLockHours,
    trustedClientConfirmationCount,
    strictQuestionFlowEnabled,
    penaltyLimit,
    penaltySystemEnabled,
  ] = await Promise.all([
    getOneHourReminderEnabled(companyId),
    getAttendanceReminderLeadMinutes(companyId),
    getAttendanceResponseTimeoutMinutes(companyId),
    getCancellationLockHours(companyId),
    getTrustedClientConfirmationCount(companyId),
    getStrictQuestionFlowEnabled(companyId),
    getPenaltyLimit(companyId),
    getPenaltySystemEnabled(companyId),
  ]);

  return {
    oneHourReminderEnabled,
    attendanceReminderLeadMinutes,
    attendanceResponseTimeoutMinutes,
    cancellationLockHours,
    trustedClientConfirmationCount,
    strictQuestionFlowEnabled,
    penaltyEnabled: penaltySystemEnabled,
    penaltySystemEnabled,
    penaltyLimit,
  };
};

// GET /api/config/courts
router.get("/courts", async (req, res) => {
  try {
    const { all } = req.query;
    const companyId = resolveCompanyId(req);
    const filter = {
      ...(all === "true" ? {} : { isActive: true }),
      ...companyScope(req, companyId),
    };
    const courts = await Court.find(filter);
    res.status(200).json({ success: true, data: courts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/courts
router.post("/courts", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const { name, surface, isIndoor, isActive } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({
        success: false,
        error: "El nombre de la cancha es obligatorio.",
      });
    }

    const normalizedName = String(name).trim();
    const escapedCourtName = escapeRegex(normalizedName);
    const scope = companyScope(req, companyId);
    const existingCourt = await Court.findOne({
      ...scope,
      name: { $regex: new RegExp(`^${escapedCourtName}$`, "i") },
    });

    if (existingCourt) {
      return res.status(400).json({
        success: false,
        error: "Ya existe una cancha con ese nombre.",
      });
    }

    const createdCourt = await Court.create({
      ...scope,
      name: normalizedName,
      ...(typeof surface === "string" && surface.trim()
        ? { surface: surface.trim() }
        : {}),
      ...(typeof isIndoor === "boolean" ? { isIndoor } : {}),
      ...(typeof isActive === "boolean" ? { isActive } : {}),
    });

    return res.status(201).json({ success: true, data: createdCourt });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/courts/:id
router.put("/courts/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const scope = companyScope(req, companyId);
    const payload = { ...req.body };

    if (Object.prototype.hasOwnProperty.call(payload, "name")) {
      const normalizedName = String(payload.name || "").trim();
      if (!normalizedName) {
        return res.status(400).json({
          success: false,
          error: "El nombre de la cancha es obligatorio.",
        });
      }

      const escapedCourtName = escapeRegex(normalizedName);
      const duplicatedCourt = await Court.findOne({
        ...scope,
        _id: { $ne: req.params.id },
        name: { $regex: new RegExp(`^${escapedCourtName}$`, "i") },
      });

      if (duplicatedCourt) {
        return res.status(400).json({
          success: false,
          error: "Ya existe una cancha con ese nombre.",
        });
      }

      payload.name = normalizedName;
    }

    const updatedCourt = await Court.findOneAndUpdate(
      { _id: req.params.id, ...scope },
      payload,
      { returnDocument: "after" },
    );

    if (!updatedCourt) {
      return res.status(404).json({
        success: false,
        error: "Cancha no encontrada.",
      });
    }

    res.status(200).json({ success: true, data: updatedCourt });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/config/courts/:id
router.delete("/courts/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const scope = companyScope(req, companyId);
    const courtId = req.params.id;

    const court = await Court.findOne({ _id: courtId, ...scope });
    if (!court) {
      return res.status(404).json({
        success: false,
        error: "Cancha no encontrada.",
      });
    }

    const [bookingsCount, fixedTurnsCount] = await Promise.all([
      Booking.countDocuments({
        ...scope,
        court: courtId,
      }),
      User.countDocuments({
        ...scope,
        "fixedTurns.court": courtId,
      }),
    ]);

    if (bookingsCount > 0 || fixedTurnsCount > 0) {
      return res.status(400).json({
        success: false,
        error:
          "No podés eliminar esta cancha porque tiene reservas o turnos fijos asociados. Podés desactivarla.",
      });
    }

    await court.deleteOne();
    return res.status(200).json({ success: true, data: { _id: courtId } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/config/slots
router.get("/slots", async (req, res) => {
  try {
    const { all } = req.query;
    const companyId = resolveCompanyId(req);
    const filter = {
      ...(all === "true" ? {} : { isActive: true }),
      ...companyScope(req, companyId),
    };
    const slots = await TimeSlot.find(filter).sort({ order: 1 });
    res.status(200).json({ success: true, data: slots });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/slots
router.post("/slots", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const { startTime, endTime, label, price, isActive } = req.body || {};
    const scope = companyScope(req, companyId);

    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: "startTime y endTime son obligatorios.",
      });
    }

    const parsedPrice = Number(price);
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({
        success: false,
        error: "El precio debe ser un número válido mayor o igual a 0.",
      });
    }

    const normalizedStart = String(startTime).trim();
    const normalizedEnd = String(endTime).trim();

    const duplicated = await TimeSlot.findOne({
      ...scope,
      startTime: normalizedStart,
      endTime: normalizedEnd,
    });

    if (duplicated) {
      return res.status(400).json({
        success: false,
        error: "Ya existe un turno con ese horario.",
      });
    }

    const lastSlot = await TimeSlot.findOne(scope).sort({ order: -1 });
    const nextOrder = (lastSlot?.order || 0) + 1;

    const createdSlot = await TimeSlot.create({
      ...scope,
      startTime: normalizedStart,
      endTime: normalizedEnd,
      ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
      price: parsedPrice,
      ...(typeof isActive === "boolean" ? { isActive } : {}),
      order: nextOrder,
    });

    return res.status(201).json({ success: true, data: createdSlot });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/slots/base-price
router.put("/slots/base-price", async (req, res) => {
  try {
    const { price } = req.body;
    const companyId = resolveCompanyId(req);
    const parsedPrice = Number(price);

    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({
        success: false,
        error: "El precio base debe ser un número válido mayor o igual a 0.",
      });
    }

    const baseFilter = companyScope(req, companyId);
    const result = await TimeSlot.updateMany(baseFilter, { $set: { price: parsedPrice } });
    const slots = await TimeSlot.find(baseFilter).sort({ order: 1 });

    res.status(200).json({
      success: true,
      data: {
        price: parsedPrice,
        updatedCount: result.modifiedCount || 0,
        slots,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/slots/:id
router.put("/slots/:id", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const updatedSlot = await TimeSlot.findOneAndUpdate(
      { _id: req.params.id, ...companyScope(req, companyId) },
      req.body,
      { returnDocument: "after" },
    );
    res.status(200).json({ success: true, data: updatedSlot });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/config/whatsapp
router.get("/whatsapp", async (_req, res) => {
  try {
    const companyId = resolveCompanyId(_req);
    res.status(200).json({
      success: true,
      data: await buildWhatsappConfigResponse(companyId),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const updateWhatsappConfig = async (req, res) => {
  try {
    const body = req.body || {};
    const companyId = resolveCompanyId(req);
    let whatsappCommand = null;
    const whatsappEnabledCandidate = firstBoolean([
      body.enabled,
      body.isEnabled,
      body.isActive,
    ]);
    const cancellationGroupEnabledCandidate = firstBoolean([
      body.cancellationGroupEnabled,
      body.cancelationGroupEnabled,
      body.groupCancellationAlertsEnabled,
      body.cancelledBookingGroupEnabled,
      body.notifyCancelledBookingGroup,
    ]);
    const dailyAvailabilityDigestEnabledCandidate = firstBoolean([
      body.dailyAvailabilityDigestEnabled,
      body.dailyGroupAvailabilityEnabled,
      body.groupDailyAvailabilityDigestEnabled,
    ]);
    const dailyAvailabilityDigestHourCandidate = firstString([
      body.dailyAvailabilityDigestHour,
      body.dailyGroupAvailabilityHour,
      body.groupDailyAvailabilityDigestHour,
    ]);
    const oneHourReminderEnabledCandidate = firstBoolean([
      body.oneHourReminderEnabled,
      body.oneHourBeforeEnabled,
      body.bookingReminderOneHourEnabled,
      body.notifyOneHourBeforeMatch,
      body.notifyOneHourBeforeBooking,
    ]);
    const cancellationGroupIdCandidate = firstString([
      body.cancellationGroupId,
      body.cancelationGroupId,
      body.groupCancellationAlertsId,
      body.cancelledBookingGroupId,
    ]);
    const cancellationGroupNameCandidate = firstString([
      body.cancellationGroupName,
      body.cancelationGroupName,
      body.groupCancellationAlertsName,
      body.cancelledBookingGroupName,
    ]);

    const hasWhatsappEnabledUpdate = typeof whatsappEnabledCandidate === "boolean";
    const hasCancellationGroupUpdate =
      typeof cancellationGroupEnabledCandidate === "boolean" ||
      typeof cancellationGroupIdCandidate === "string" ||
      typeof cancellationGroupNameCandidate === "string";
    const hasDailyAvailabilityDigestUpdate =
      typeof dailyAvailabilityDigestEnabledCandidate === "boolean" ||
      typeof dailyAvailabilityDigestHourCandidate === "string";
    const hasOneHourReminderUpdate =
      typeof oneHourReminderEnabledCandidate === "boolean";

    if (
      !hasWhatsappEnabledUpdate &&
      !hasCancellationGroupUpdate &&
      !hasDailyAvailabilityDigestUpdate &&
      !hasOneHourReminderUpdate
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Debés enviar al menos una configuración válida de WhatsApp (enabled, recordatorio 1 hora o datos del grupo de cancelación).",
      });
    }

    if (hasWhatsappEnabledUpdate) {
      await setWhatsappEnabledConfigOnly(whatsappEnabledCandidate, companyId);
      const { command } = await enqueueWhatsappCommand({
        companyId,
        type: COMMAND_TYPES.SET_ENABLED,
        payload: { enabled: Boolean(whatsappEnabledCandidate) },
        requestedBy: req.user?._id || null,
      });
      whatsappCommand = command;
    }

    let cancellationGroup = await getWhatsappCancellationGroupSettings(companyId);
    if (hasCancellationGroupUpdate) {
      const nextEnabled =
        typeof cancellationGroupEnabledCandidate === "boolean"
          ? cancellationGroupEnabledCandidate
          : cancellationGroup.enabled;
      const nextGroupId =
        typeof cancellationGroupIdCandidate === "string"
          ? cancellationGroupIdCandidate.trim()
          : cancellationGroup.groupId;
      const nextGroupName =
        typeof cancellationGroupNameCandidate === "string"
          ? cancellationGroupNameCandidate.trim()
          : cancellationGroup.groupName;

      if (nextEnabled && !nextGroupId) {
        return res.status(400).json({
          success: false,
          error:
            "Para activar avisos al grupo de cancelaciones debés informar un groupId válido.",
        });
      }

      const savedConfig = await setWhatsappCancellationGroupSettings(
        {
          enabled: nextEnabled,
          groupId: nextGroupId,
          groupName: nextGroupName,
        },
        companyId,
      );
      cancellationGroup = {
        enabled: Boolean(savedConfig.cancellationGroupEnabled),
        groupId: String(savedConfig.cancellationGroupId || ""),
        groupName: String(savedConfig.cancellationGroupName || ""),
        dailyAvailabilityDigestEnabled: Boolean(
          savedConfig.dailyAvailabilityDigestEnabled,
        ),
        dailyAvailabilityDigestHour: String(
          savedConfig.dailyAvailabilityDigestHour ||
            DEFAULT_DAILY_AVAILABILITY_DIGEST_HOUR,
        ),
      };
    }

    if (hasDailyAvailabilityDigestUpdate) {
      if (
        typeof dailyAvailabilityDigestHourCandidate === "string" &&
        !DAILY_HOUR_REGEX.test(dailyAvailabilityDigestHourCandidate.trim())
      ) {
        return res.status(400).json({
          success: false,
          error: "La hora del resumen diario debe tener formato HH:mm.",
        });
      }
      if (!cancellationGroup.groupId) {
        return res.status(400).json({
          success: false,
          error:
            "Para activar el resumen diario debés configurar primero un grupo válido.",
        });
      }
      const savedDigestConfig = await setDailyAvailabilityDigestStatus(
        {
          enabled:
            typeof dailyAvailabilityDigestEnabledCandidate === "boolean"
              ? dailyAvailabilityDigestEnabledCandidate
              : cancellationGroup.dailyAvailabilityDigestEnabled,
          hour:
            typeof dailyAvailabilityDigestHourCandidate === "string"
              ? dailyAvailabilityDigestHourCandidate.trim()
              : cancellationGroup.dailyAvailabilityDigestHour,
        },
        companyId,
      );
      cancellationGroup.dailyAvailabilityDigestEnabled = Boolean(
        savedDigestConfig.dailyAvailabilityDigestEnabled,
      );
      cancellationGroup.dailyAvailabilityDigestHour = String(
        savedDigestConfig.dailyAvailabilityDigestHour ||
          DEFAULT_DAILY_AVAILABILITY_DIGEST_HOUR,
      );
    }

    if (hasOneHourReminderUpdate) {
      await setOneHourReminderEnabled(oneHourReminderEnabledCandidate, companyId);
    }

    return res.status(200).json({
      success: true,
      data: {
        ...(await buildWhatsappConfigResponse(companyId)),
        commandId: whatsappCommand?._id || null,
      },
    });
  } catch (error) {
    const message = String(error?.message || "");
    if (message.includes("ya está abierta en otro proceso")) {
      return res.status(409).json({
        success: false,
        error: message,
      });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
};

// PUT/PATCH /api/config/whatsapp
router.put("/whatsapp", updateWhatsappConfig);
router.patch("/whatsapp", updateWhatsappConfig);

// GET /api/config/notifications/reminders
router.get("/notifications/reminders", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const enabled = await getOneHourReminderEnabled(companyId);
    return res.status(200).json({
      success: true,
      data: {
        oneHourReminderEnabled: enabled,
        oneHourBeforeEnabled: enabled,
        bookingReminderOneHourEnabled: enabled,
        notifyOneHourBeforeMatch: enabled,
        notifyOneHourBeforeBooking: enabled,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

const updateOneHourReminderConfig = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const body = req.body || {};
    const enabledCandidate = firstBoolean([
      body.oneHourReminderEnabled,
      body.oneHourBeforeEnabled,
      body.bookingReminderOneHourEnabled,
      body.notifyOneHourBeforeMatch,
      body.notifyOneHourBeforeBooking,
    ]);

    if (typeof enabledCandidate !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "Debés enviar un booleano para el recordatorio de 1 hora.",
      });
    }

    const updated = await setOneHourReminderEnabled(enabledCandidate, companyId);
    const enabled =
      typeof updated.oneHourReminderEnabled === "boolean"
        ? updated.oneHourReminderEnabled
        : Boolean(enabledCandidate);

    return res.status(200).json({
      success: true,
      data: {
        oneHourReminderEnabled: enabled,
        oneHourBeforeEnabled: enabled,
        bookingReminderOneHourEnabled: enabled,
        notifyOneHourBeforeMatch: enabled,
        notifyOneHourBeforeBooking: enabled,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// PUT/PATCH /api/config/notifications/reminders
router.put("/notifications/reminders", updateOneHourReminderConfig);
router.patch("/notifications/reminders", updateOneHourReminderConfig);

// Compatibility aliases used by frontend fallbacks.
router.get("/settings", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const enabled = await getOneHourReminderEnabled(companyId);
    return res.status(200).json({
      success: true,
      data: {
        oneHourReminderEnabled: enabled,
        bookingReminderOneHourEnabled: enabled,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
router.put("/settings", updateOneHourReminderConfig);
router.patch("/settings", updateOneHourReminderConfig);

// GET /api/config/bot-automation
router.get("/bot-automation", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    return res.status(200).json({
      success: true,
      data: await buildBotAutomationConfigResponse(companyId),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT/PATCH /api/config/bot-automation
const updateBotAutomationConfig = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const body = req.body || {};
    const oneHourReminderEnabledCandidate = firstBoolean([
      body.oneHourReminderEnabled,
      body.oneHourBeforeEnabled,
      body.bookingReminderOneHourEnabled,
      body.notifyOneHourBeforeMatch,
      body.notifyOneHourBeforeBooking,
    ]);
    const attendanceReminderLeadMinutesRaw = body.attendanceReminderLeadMinutes;
    const attendanceResponseTimeoutMinutesRaw =
      body.attendanceResponseTimeoutMinutes;
    const cancellationLockHoursRaw = [
      body.cancellationLockHours,
      body.cancellationWindowHours,
      body.minHoursBeforeCancellation,
    ].find((value) => value !== undefined);
    const trustedClientConfirmationCountRaw = body.trustedClientConfirmationCount;
    const strictQuestionFlowEnabledCandidate = firstBoolean([
      body.strictQuestionFlowEnabled,
      body.strictQuestionFlow,
      body.singleQuestionMode,
      body.singleQuestionPerTurn,
      body.sequentialQuestionFlow,
    ]);
    const penaltyLimitRaw = body.penaltyLimit;
    const penaltyEnabledCandidate = firstBoolean([
      body.penaltyEnabled,
      body.penaltySystemEnabled,
      body.penaltiesEnabled,
    ]);

    const hasOneHourReminderUpdate =
      typeof oneHourReminderEnabledCandidate === "boolean";
    const hasAttendanceLeadMinutesUpdate =
      attendanceReminderLeadMinutesRaw !== undefined;
    const hasAttendanceResponseTimeoutUpdate =
      attendanceResponseTimeoutMinutesRaw !== undefined;
    const hasCancellationLockHoursUpdate = cancellationLockHoursRaw !== undefined;
    const hasTrustedConfirmationUpdate =
      trustedClientConfirmationCountRaw !== undefined;
    const hasStrictQuestionFlowUpdate =
      typeof strictQuestionFlowEnabledCandidate === "boolean";
    const hasPenaltyEnabledUpdate = typeof penaltyEnabledCandidate === "boolean";
    const hasPenaltyLimitUpdate = penaltyLimitRaw !== undefined;

    if (
      !hasOneHourReminderUpdate &&
      !hasAttendanceLeadMinutesUpdate &&
      !hasAttendanceResponseTimeoutUpdate &&
      !hasCancellationLockHoursUpdate &&
      !hasTrustedConfirmationUpdate &&
      !hasStrictQuestionFlowUpdate &&
      !hasPenaltyEnabledUpdate &&
      !hasPenaltyLimitUpdate
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Debés enviar al menos una configuración válida (oneHourReminderEnabled, attendanceReminderLeadMinutes, attendanceResponseTimeoutMinutes, cancellationLockHours, trustedClientConfirmationCount, strictQuestionFlowEnabled, penaltyEnabled, penaltyLimit).",
      });
    }

    if (hasOneHourReminderUpdate) {
      await setOneHourReminderEnabled(oneHourReminderEnabledCandidate, companyId);
    }

    if (hasAttendanceLeadMinutesUpdate) {
      const parsedLead = Number(attendanceReminderLeadMinutesRaw);
      if (!Number.isInteger(parsedLead) || parsedLead < 5 || parsedLead > 240) {
        return res.status(400).json({
          success: false,
          error:
            `El campo 'attendanceReminderLeadMinutes' debe ser un entero entre 5 y 240. Valor recomendado por defecto: ${DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES}.`,
        });
      }
      await setAttendanceReminderLeadMinutes(parsedLead, companyId);
    }

    if (hasAttendanceResponseTimeoutUpdate) {
      const parsedTimeout = Number(attendanceResponseTimeoutMinutesRaw);
      if (
        !Number.isInteger(parsedTimeout) ||
        parsedTimeout < 1 ||
        parsedTimeout > 240
      ) {
        return res.status(400).json({
          success: false,
          error:
            `El campo 'attendanceResponseTimeoutMinutes' debe ser un entero entre 1 y 240. Valor recomendado por defecto: ${DEFAULT_ATTENDANCE_RESPONSE_TIMEOUT_MINUTES}.`,
        });
      }
      await setAttendanceResponseTimeoutMinutes(parsedTimeout, companyId);
    }

    if (hasCancellationLockHoursUpdate) {
      const parsedHours = Number(cancellationLockHoursRaw);
      if (!Number.isInteger(parsedHours) || parsedHours < 0 || parsedHours > 72) {
        return res.status(400).json({
          success: false,
          error:
            `El campo 'cancellationLockHours' debe ser un entero entre 0 y 72. Valor recomendado por defecto: ${DEFAULT_CANCELLATION_LOCK_HOURS}.`,
        });
      }
      await setCancellationLockHours(parsedHours, companyId);
    }

    if (hasTrustedConfirmationUpdate) {
      const parsedTrusted = Number(trustedClientConfirmationCountRaw);
      if (!Number.isInteger(parsedTrusted) || parsedTrusted < 1 || parsedTrusted > 20) {
        return res.status(400).json({
          success: false,
          error:
            `El campo 'trustedClientConfirmationCount' debe ser un entero entre 1 y 20. Valor recomendado por defecto: ${DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT}.`,
        });
      }
      await setTrustedClientConfirmationCount(parsedTrusted, companyId);
    }

    if (hasStrictQuestionFlowUpdate) {
      await setStrictQuestionFlowEnabled(
        strictQuestionFlowEnabledCandidate,
        companyId,
      );
    }

    if (hasPenaltyEnabledUpdate) {
      await setPenaltySystemEnabled(penaltyEnabledCandidate, companyId);
    }

    if (hasPenaltyLimitUpdate) {
      const parsedPenalty = Number(penaltyLimitRaw);
      if (!Number.isInteger(parsedPenalty) || parsedPenalty < 1) {
        return res.status(400).json({
          success: false,
          error:
            `El campo 'penaltyLimit' debe ser un entero mayor o igual a 1. Valor recomendado por defecto: ${DEFAULT_PENALTY_LIMIT}.`,
        });
      }
      await setPenaltyLimit(parsedPenalty, companyId);
    }

    return res.status(200).json({
      success: true,
      data: await buildBotAutomationConfigResponse(companyId),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

router.put("/bot-automation", updateBotAutomationConfig);
router.patch("/bot-automation", updateBotAutomationConfig);

const getWhatsappGroupsCompatibility = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const snapshot = await getWhatsappGroupsSnapshot(companyId);
    const { command } = await enqueueWhatsappCommand({
      companyId,
      type: COMMAND_TYPES.LIST_GROUPS,
      payload: {},
      requestedBy: req.user?._id || null,
    });

    const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
    const commandId = command?._id ? String(command._id) : null;
    const refreshedAt = snapshot.refreshedAt || null;
    const responseType = String(req.query?.type || "").trim().toLowerCase();
    const includeChats = !responseType || responseType === "group";

    return res.status(200).json({
      success: true,
      data: includeChats
        ? { groups, chats: groups, commandId, refreshedAt }
        : { groups, commandId, refreshedAt },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// GET /api/config/whatsapp/groups
router.get("/whatsapp/groups", getWhatsappGroupsCompatibility);
// GET /api/config/whatsapp/chats?type=group
router.get("/whatsapp/chats", getWhatsappGroupsCompatibility);

// GET /api/config/penalties
router.get("/penalties", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const [penaltyLimit, penaltySystemEnabled] = await Promise.all([
      getPenaltyLimit(companyId),
      getPenaltySystemEnabled(companyId),
    ]);
    return res.status(200).json({
      success: true,
      data: {
        penaltyLimit,
        penaltyEnabled: penaltySystemEnabled,
        penaltySystemEnabled,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// PUT /api/config/penalties
router.put("/penalties", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const rawPenaltyLimit = req.body?.penaltyLimit;
    const parsed = Number(rawPenaltyLimit);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return res.status(400).json({
        success: false,
        error: `El campo 'penaltyLimit' debe ser un entero mayor o igual a 1. Valor recomendado por defecto: ${DEFAULT_PENALTY_LIMIT}.`,
      });
    }

    const config = await setPenaltyLimit(parsed, companyId);
    return res.status(200).json({
      success: true,
      data: { penaltyLimit: config.penaltyLimit },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;

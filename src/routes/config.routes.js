const express = require("express");
const router = express.Router();
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const { getWhatsappState } = require("../state/whatsapp.state");
const { setWhatsappEnabled } = require("../services/whatsappControl.service");
const {
  DEFAULT_PENALTY_LIMIT,
  getOneHourReminderEnabled,
  getPenaltyLimit,
  setPenaltyLimit,
  setOneHourReminderEnabled,
  getWhatsappCancellationGroupSettings,
  setWhatsappCancellationGroupSettings,
  setDailyAvailabilityDigestStatus,
} = require("../services/appConfig.service");
const { listWhatsappGroups } = require("../services/whatsappCancellationGroup.service");

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
  const state = getWhatsappState(companyId);
  const cancellationGroup = await getWhatsappCancellationGroupSettings(companyId);
  const oneHourReminderEnabled = await getOneHourReminderEnabled(companyId);

  return {
    ...state,
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
    const updatedCourt = await Court.findOneAndUpdate(
      { _id: req.params.id, ...companyScope(req, companyId) },
      req.body,
      { new: true },
    );
    res.status(200).json({ success: true, data: updatedCourt });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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
      { new: true },
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
      typeof dailyAvailabilityDigestEnabledCandidate === "boolean";
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
      await setWhatsappEnabled(whatsappEnabledCandidate, companyId);
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
      };
    }

    if (hasDailyAvailabilityDigestUpdate) {
      if (!cancellationGroup.groupId) {
        return res.status(400).json({
          success: false,
          error:
            "Para activar el resumen diario debés configurar primero un grupo válido.",
        });
      }
      const savedDigestConfig = await setDailyAvailabilityDigestStatus(
        dailyAvailabilityDigestEnabledCandidate,
        companyId,
      );
      cancellationGroup.dailyAvailabilityDigestEnabled = Boolean(
        savedDigestConfig.dailyAvailabilityDigestEnabled,
      );
    }

    if (hasOneHourReminderUpdate) {
      await setOneHourReminderEnabled(oneHourReminderEnabledCandidate, companyId);
    }

    return res.status(200).json({
      success: true,
      data: await buildWhatsappConfigResponse(companyId),
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

// GET /api/config/whatsapp/groups
router.get("/whatsapp/groups", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const groups = await listWhatsappGroups(companyId);
    return res.status(200).json({ success: true, data: { groups } });
  } catch (error) {
    const message = String(error?.message || "");
    if (
      message.includes("no está listo") ||
      message.includes("no está inicializado") ||
      message.includes("No existe cliente")
    ) {
      return res.status(200).json({
        success: true,
        data: { groups: [] },
        error:
          "WhatsApp todavía no está listo. Activá y vinculá la sesión para poder listar grupos.",
      });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/config/penalties
router.get("/penalties", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const penaltyLimit = await getPenaltyLimit(companyId);
    return res.status(200).json({
      success: true,
      data: { penaltyLimit },
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

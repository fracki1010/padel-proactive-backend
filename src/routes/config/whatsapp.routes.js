'use strict';

const express = require('express');
const router = express.Router();
const {
  resolveCompanyId,
  firstBoolean,
  firstString,
  buildWhatsappConfigResponse,
  DAILY_HOUR_REGEX,
} = require('./shared');
const {
  DEFAULT_DAILY_AVAILABILITY_DIGEST_HOUR,
  getWhatsappCancellationGroupSettings,
  setWhatsappEnabledConfigOnly,
  setWhatsappCancellationGroupSettings,
  setDailyAvailabilityDigestStatus,
  setOneHourReminderEnabled,
} = require('../../services/appConfig.service');
const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require('../../services/whatsappCommandQueue.service');
const {
  getWhatsappGroupsSnapshot,
} = require('../../services/whatsappGroupsSnapshot.service');

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
    const dailyAvailabilityDigestFormatCandidate =
      body.dailyAvailabilityDigestFormat === "image" ||
      body.dailyAvailabilityDigestFormat === "text"
        ? body.dailyAvailabilityDigestFormat
        : null;
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
      typeof dailyAvailabilityDigestHourCandidate === "string" ||
      dailyAvailabilityDigestFormatCandidate !== null;
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
        dailyAvailabilityDigestFormat: String(
          savedConfig.dailyAvailabilityDigestFormat || "text",
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
          format:
            dailyAvailabilityDigestFormatCandidate !== null
              ? dailyAvailabilityDigestFormatCandidate
              : cancellationGroup.dailyAvailabilityDigestFormat,
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
      cancellationGroup.dailyAvailabilityDigestFormat = String(
        savedDigestConfig.dailyAvailabilityDigestFormat || "text",
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

// POST /api/config/whatsapp/send-digest-now
router.post("/whatsapp/send-digest-now", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const { command } = await enqueueWhatsappCommand({
      companyId,
      type: COMMAND_TYPES.SEND_DIGEST_NOW,
      payload: {},
      requestedBy: req.user?._id || null,
    });
    return res.status(200).json({
      success: true,
      data: { commandId: command._id, message: "Digest en cola de envío." },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/config/whatsapp/reset-session
router.post("/whatsapp/reset-session", async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const { command } = await enqueueWhatsappCommand({
      companyId,
      type: COMMAND_TYPES.RESET_SESSION,
      payload: {},
      requestedBy: req.user?._id || null,
    });
    return res.status(200).json({
      success: true,
      data: {
        commandId: command._id,
        message: "Sesión de WhatsApp reiniciada. Se generará un nuevo QR.",
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

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

module.exports = router;
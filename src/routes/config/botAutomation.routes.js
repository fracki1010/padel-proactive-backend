'use strict';

const express = require('express');
const router = express.Router();
const {
  resolveCompanyId,
  firstBoolean,
  buildBotAutomationConfigResponse,
} = require('./shared');
const {
  DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES,
  DEFAULT_ATTENDANCE_RESPONSE_TIMEOUT_MINUTES,
  DEFAULT_CANCELLATION_LOCK_HOURS,
  DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT,
  DEFAULT_PENALTY_LIMIT,
  setOneHourReminderEnabled,
  setAttendanceReminderLeadMinutes,
  setAttendanceResponseTimeoutMinutes,
  setCancellationLockHours,
  setTrustedClientConfirmationCount,
  setStrictQuestionFlowEnabled,
  setPenaltySystemEnabled,
  setPenaltyLimit,
} = require('../../services/appConfig.service');

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

module.exports = router;
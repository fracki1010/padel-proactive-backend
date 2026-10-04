'use strict';

const {
  getWhatsappRuntimeState,
} = require('../../services/whatsappRuntimeState.service');
const {
  getAttendanceReminderLeadMinutes,
  getAttendanceResponseTimeoutMinutes,
  getCancellationLockHours,
  getOneHourReminderEnabled,
  getPenaltyLimit,
  getPenaltySystemEnabled,
  getStrictQuestionFlowEnabled,
  getTrustedClientConfirmationCount,
  getWhatsappCancellationGroupSettings,
} = require('../../services/appConfig.service');
const {
  DEFAULT_SERVICE_NAME,
  getWorkerHealth,
} = require('../../services/workerHeartbeat.service');

const DAILY_HOUR_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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
    dailyAvailabilityDigestFormat: cancellationGroup.dailyAvailabilityDigestFormat || "text",
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

module.exports = {
  DAILY_HOUR_REGEX,
  ISO_DATE_REGEX,
  resolveCompanyId,
  escapeRegex,
  companyScope,
  firstBoolean,
  firstString,
  buildWhatsappConfigResponse,
  buildBotAutomationConfigResponse,
};
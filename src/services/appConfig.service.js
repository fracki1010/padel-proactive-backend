const AppConfig = require("../models/appConfig.model");

const CONFIG_KEY = "main";
const DEFAULT_PENALTY_LIMIT = 2;
const DEFAULT_PENALTY_SYSTEM_ENABLED = true;
const DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES = 60;
const DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT = 3;
const DEFAULT_CANCELLATION_LOCK_HOURS = 0;

const buildConfigFilter = (companyId = null) => ({
  companyId: companyId || null,
  key: CONFIG_KEY,
});

const normalizePenaltyLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_PENALTY_LIMIT;
  }
  return parsed;
};

const normalizeAttendanceReminderLeadMinutes = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 240) {
    return DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES;
  }
  return parsed;
};

const normalizeTrustedClientConfirmationCount = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    return DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT;
  }
  return parsed;
};

const normalizeCancellationLockHours = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 72) {
    return DEFAULT_CANCELLATION_LOCK_HOURS;
  }
  return parsed;
};

const normalizeString = (value) =>
  typeof value === "string" ? value.trim() : String(value || "").trim();

const ensureAppConfig = async (companyId = null) => {
  const existing = await AppConfig.findOne(buildConfigFilter(companyId));
  if (existing) return existing;

  return AppConfig.create({
    companyId: companyId || null,
    key: CONFIG_KEY,
    whatsappEnabled: false,
    oneHourReminderEnabled: true,
    attendanceReminderLeadMinutes: DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES,
    trustedClientConfirmationCount: DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT,
    penaltyLimit: DEFAULT_PENALTY_LIMIT,
    penaltySystemEnabled: DEFAULT_PENALTY_SYSTEM_ENABLED,
    cancellationGroupEnabled: false,
    cancellationGroupId: "",
    cancellationGroupName: "",
    cancellationLockHours: DEFAULT_CANCELLATION_LOCK_HOURS,
    dailyAvailabilityDigestEnabled: false,
    dailyAvailabilityDigestLastSentDate: "",
  });
};

const getPenaltyLimit = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  return normalizePenaltyLimit(config.penaltyLimit);
};

const setPenaltyLimit = async (penaltyLimit, companyId = null) => {
  const normalized = normalizePenaltyLimit(penaltyLimit);
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { penaltyLimit: normalized } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const getPenaltySystemEnabled = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  if (typeof config.penaltySystemEnabled === "boolean") {
    return config.penaltySystemEnabled;
  }
  return DEFAULT_PENALTY_SYSTEM_ENABLED;
};

const setPenaltySystemEnabled = async (enabled, companyId = null) => {
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { penaltySystemEnabled: Boolean(enabled) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const getAttendanceReminderLeadMinutes = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  return normalizeAttendanceReminderLeadMinutes(
    config.attendanceReminderLeadMinutes,
  );
};

const setAttendanceReminderLeadMinutes = async (
  attendanceReminderLeadMinutes,
  companyId = null,
) => {
  const normalized = normalizeAttendanceReminderLeadMinutes(
    attendanceReminderLeadMinutes,
  );
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { attendanceReminderLeadMinutes: normalized } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const getTrustedClientConfirmationCount = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  return normalizeTrustedClientConfirmationCount(
    config.trustedClientConfirmationCount,
  );
};

const setTrustedClientConfirmationCount = async (
  trustedClientConfirmationCount,
  companyId = null,
) => {
  const normalized = normalizeTrustedClientConfirmationCount(
    trustedClientConfirmationCount,
  );
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { trustedClientConfirmationCount: normalized } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const getCancellationLockHours = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  return normalizeCancellationLockHours(config.cancellationLockHours);
};

const setCancellationLockHours = async (
  cancellationLockHours,
  companyId = null,
) => {
  const normalized = normalizeCancellationLockHours(cancellationLockHours);
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { cancellationLockHours: normalized } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const getOneHourReminderEnabled = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  if (typeof config.oneHourReminderEnabled === "boolean") {
    return config.oneHourReminderEnabled;
  }
  return true;
};

const setOneHourReminderEnabled = async (enabled, companyId = null) => {
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    {
      $set: {
        oneHourReminderEnabled: Boolean(enabled),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const getWhatsappCancellationGroupSettings = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  return {
    enabled: Boolean(config.cancellationGroupEnabled),
    groupId: normalizeString(config.cancellationGroupId),
    groupName: normalizeString(config.cancellationGroupName),
    dailyAvailabilityDigestEnabled: Boolean(config.dailyAvailabilityDigestEnabled),
    dailyAvailabilityDigestLastSentDate: normalizeString(
      config.dailyAvailabilityDigestLastSentDate,
    ),
  };
};

const setWhatsappCancellationGroupSettings = async (
  { enabled, groupId, groupName },
  companyId = null,
) => {
  const nextEnabled = Boolean(enabled);
  const nextGroupId = normalizeString(groupId);
  const nextGroupName = normalizeString(groupName);

  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    {
      $set: {
        cancellationGroupEnabled: nextEnabled,
        cancellationGroupId: nextGroupId,
        cancellationGroupName: nextGroupName,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const setDailyAvailabilityDigestStatus = async (
  enabled,
  companyId = null,
) => {
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    {
      $set: {
        dailyAvailabilityDigestEnabled: Boolean(enabled),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const setDailyAvailabilityDigestLastSentDate = async (
  isoDate,
  companyId = null,
) => {
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    {
      $set: {
        dailyAvailabilityDigestLastSentDate: normalizeString(isoDate),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

module.exports = {
  DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES,
  DEFAULT_CANCELLATION_LOCK_HOURS,
  DEFAULT_PENALTY_LIMIT,
  DEFAULT_PENALTY_SYSTEM_ENABLED,
  DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT,
  getCancellationLockHours,
  ensureAppConfig,
  getAttendanceReminderLeadMinutes,
  getOneHourReminderEnabled,
  getPenaltyLimit,
  getPenaltySystemEnabled,
  getTrustedClientConfirmationCount,
  setCancellationLockHours,
  setAttendanceReminderLeadMinutes,
  setPenaltyLimit,
  setPenaltySystemEnabled,
  setOneHourReminderEnabled,
  setTrustedClientConfirmationCount,
  getWhatsappCancellationGroupSettings,
  setWhatsappCancellationGroupSettings,
  setDailyAvailabilityDigestStatus,
  setDailyAvailabilityDigestLastSentDate,
};

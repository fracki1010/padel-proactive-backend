const AppConfig = require("../models/appConfig.model");

const MAX_DEPOSIT_AMOUNT = AppConfig.MAX_DEPOSIT_AMOUNT;
const MAX_HOLD_MINUTES = AppConfig.MAX_HOLD_MINUTES;

const CONFIG_KEY = "main";
const DEFAULT_PENALTY_LIMIT = 2;
const DEFAULT_PENALTY_SYSTEM_ENABLED = true;
const DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES = 60;
const DEFAULT_ATTENDANCE_RESPONSE_TIMEOUT_MINUTES = Number(
  process.env.ATTENDANCE_RESPONSE_TIMEOUT_MINUTES || 15,
);
const DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT = 3;
const DEFAULT_STRICT_QUESTION_FLOW_ENABLED = false;
const DEFAULT_CANCELLATION_LOCK_HOURS = 2;
const DAILY_HOUR_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_DAILY_AVAILABILITY_DIGEST_HOUR = DAILY_HOUR_REGEX.test(
  String(process.env.DAILY_AVAILABILITY_DIGEST_TIME || "").trim(),
)
  ? String(process.env.DAILY_AVAILABILITY_DIGEST_TIME).trim()
  : "09:00";

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

const normalizeAttendanceResponseTimeoutMinutes = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 240) {
    return DEFAULT_ATTENDANCE_RESPONSE_TIMEOUT_MINUTES;
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

const DEFAULT_DEPOSIT_ENABLED = false;
const DEFAULT_DEPOSIT_AMOUNT = 0;
const DEFAULT_HOLD_MINUTES = 15;
const DEPOSIT_FIELDS = ["depositEnabled", "depositAmount", "holdMinutes"];

const normalizeString = (value) =>
  typeof value === "string" ? value.trim() : String(value || "").trim();

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const normalizeDepositAmount = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DEPOSIT_AMOUNT) {
    return DEFAULT_DEPOSIT_AMOUNT;
  }
  return parsed;
};

const normalizeHoldMinutes = (value) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_HOLD_MINUTES) {
    return DEFAULT_HOLD_MINUTES;
  }
  return parsed;
};

// Pure: merges the provided deposit fields over the current settings and
// validates the result. Returns { valid, error, provided, value } so callers
// can map invalid input to HTTP 400 and persist only the provided fields.
const resolveDepositUpdate = (input = {}, current = {}) => {
  const source = input && typeof input === "object" ? input : {};
  const provided = DEPOSIT_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(source, field),
  );
  const value = {
    depositEnabled:
      typeof current?.depositEnabled === "boolean"
        ? current.depositEnabled
        : DEFAULT_DEPOSIT_ENABLED,
    depositAmount: normalizeDepositAmount(current?.depositAmount),
    holdMinutes: normalizeHoldMinutes(current?.holdMinutes),
  };

  if (provided.includes("depositEnabled")) {
    if (typeof source.depositEnabled !== "boolean") {
      return {
        valid: false,
        error: "depositEnabled must be a boolean.",
        provided,
        value,
      };
    }
    value.depositEnabled = source.depositEnabled;
  }

  if (provided.includes("depositAmount")) {
    const amount = Number(source.depositAmount);
    if (
      isBlank(source.depositAmount) ||
      !Number.isInteger(amount) ||
      amount < 0 ||
      amount > MAX_DEPOSIT_AMOUNT
    ) {
      return {
        valid: false,
        error: `depositAmount must be an integer between 0 and ${MAX_DEPOSIT_AMOUNT}.`,
        provided,
        value,
      };
    }
    value.depositAmount = amount;
  }

  if (provided.includes("holdMinutes")) {
    const holdMinutes = Number(source.holdMinutes);
    if (
      isBlank(source.holdMinutes) ||
      !Number.isInteger(holdMinutes) ||
      holdMinutes < 1 ||
      holdMinutes > MAX_HOLD_MINUTES
    ) {
      return {
        valid: false,
        error: `holdMinutes must be an integer between 1 and ${MAX_HOLD_MINUTES}.`,
        provided,
        value,
      };
    }
    value.holdMinutes = holdMinutes;
  }

  if (value.depositEnabled && value.depositAmount <= 0) {
    return {
      valid: false,
      error: "depositAmount must be greater than 0 when deposits are enabled.",
      provided,
      value,
    };
  }

  return { valid: true, error: null, provided, value };
};

const validateDepositSettings = (input = {}) => resolveDepositUpdate(input, {});

const resolveConfigModel = (options) =>
  (options && options.model) || AppConfig;

const getDepositSettings = async (companyId = null, options = {}) => {
  const config = await resolveConfigModel(options).findOne(
    buildConfigFilter(companyId),
  );
  return {
    depositEnabled: Boolean(config?.depositEnabled),
    depositAmount: normalizeDepositAmount(config?.depositAmount),
    holdMinutes: normalizeHoldMinutes(config?.holdMinutes),
  };
};

const setDepositSettings = async (settings = {}, companyId = null, options = {}) => {
  const model = resolveConfigModel(options);
  const current = await getDepositSettings(companyId, options);
  const { valid, error, provided, value } = resolveDepositUpdate(settings, current);

  if (!valid) {
    const validationError = new Error(error);
    validationError.statusCode = 400;
    throw validationError;
  }
  if (provided.length === 0) {
    const validationError = new Error("At least one deposit setting is required.");
    validationError.statusCode = 400;
    throw validationError;
  }

  const depositPatch = {};
  for (const field of provided) {
    depositPatch[field] = value[field];
  }

  return model.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: depositPatch },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};
const normalizeDailyAvailabilityDigestHour = (value) => {
  const normalized = normalizeString(value);
  return DAILY_HOUR_REGEX.test(normalized)
    ? normalized
    : DEFAULT_DAILY_AVAILABILITY_DIGEST_HOUR;
};

const ensureAppConfig = async (companyId = null) => {
  const existing = await AppConfig.findOne(buildConfigFilter(companyId));
  if (existing) {
    let shouldSave = false;
    if (
      existing.attendanceResponseTimeoutMinutes === undefined ||
      existing.attendanceResponseTimeoutMinutes === null ||
      Number.isNaN(Number(existing.attendanceResponseTimeoutMinutes))
    ) {
      existing.attendanceResponseTimeoutMinutes =
        DEFAULT_ATTENDANCE_RESPONSE_TIMEOUT_MINUTES;
      shouldSave = true;
    }
    if (
      existing.cancellationLockHours === undefined ||
      existing.cancellationLockHours === null ||
      Number.isNaN(Number(existing.cancellationLockHours))
    ) {
      existing.cancellationLockHours = DEFAULT_CANCELLATION_LOCK_HOURS;
      shouldSave = true;
    }
    if (
      !DAILY_HOUR_REGEX.test(normalizeString(existing.dailyAvailabilityDigestHour))
    ) {
      existing.dailyAvailabilityDigestHour = DEFAULT_DAILY_AVAILABILITY_DIGEST_HOUR;
      shouldSave = true;
    }
    if (typeof existing.strictQuestionFlowEnabled !== "boolean") {
      existing.strictQuestionFlowEnabled = DEFAULT_STRICT_QUESTION_FLOW_ENABLED;
      shouldSave = true;
    }
    if (shouldSave) {
      await existing.save();
    }
    return existing;
  }

  return AppConfig.create({
    companyId: companyId || null,
    key: CONFIG_KEY,
    whatsappEnabled: false,
    oneHourReminderEnabled: true,
    attendanceReminderLeadMinutes: DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES,
    attendanceResponseTimeoutMinutes:
      DEFAULT_ATTENDANCE_RESPONSE_TIMEOUT_MINUTES,
    trustedClientConfirmationCount: DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT,
    strictQuestionFlowEnabled: DEFAULT_STRICT_QUESTION_FLOW_ENABLED,
    penaltyLimit: DEFAULT_PENALTY_LIMIT,
    penaltySystemEnabled: DEFAULT_PENALTY_SYSTEM_ENABLED,
    cancellationGroupEnabled: false,
    cancellationGroupId: "",
    cancellationGroupName: "",
    cancellationLockHours: DEFAULT_CANCELLATION_LOCK_HOURS,
    dailyAvailabilityDigestEnabled: false,
    dailyAvailabilityDigestHour: DEFAULT_DAILY_AVAILABILITY_DIGEST_HOUR,
    dailyAvailabilityDigestLastSentDate: "",
  });
};

const getWhatsappEnabled = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  return Boolean(config.whatsappEnabled);
};

const setWhatsappEnabledConfigOnly = async (enabled, companyId = null) =>
  AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { whatsappEnabled: Boolean(enabled) } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

const getPenaltyLimit = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  return normalizePenaltyLimit(config.penaltyLimit);
};

const setPenaltyLimit = async (penaltyLimit, companyId = null) => {
  const normalized = normalizePenaltyLimit(penaltyLimit);
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { penaltyLimit: normalized } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

const getAttendanceResponseTimeoutMinutes = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  return normalizeAttendanceResponseTimeoutMinutes(
    config.attendanceResponseTimeoutMinutes,
  );
};

const setAttendanceResponseTimeoutMinutes = async (
  attendanceResponseTimeoutMinutes,
  companyId = null,
) => {
  const normalized = normalizeAttendanceResponseTimeoutMinutes(
    attendanceResponseTimeoutMinutes,
  );
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { attendanceResponseTimeoutMinutes: normalized } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

const getStrictQuestionFlowEnabled = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  if (typeof config.strictQuestionFlowEnabled === "boolean") {
    return config.strictQuestionFlowEnabled;
  }
  return DEFAULT_STRICT_QUESTION_FLOW_ENABLED;
};

const setStrictQuestionFlowEnabled = async (enabled, companyId = null) => {
  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { strictQuestionFlowEnabled: Boolean(enabled) } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

const normalizeDailyAvailabilityDigestFormat = (value) => {
  const v = normalizeString(value);
  return v === "image" ? "image" : "text";
};

const getWhatsappCancellationGroupSettings = async (companyId = null) => {
  const config = await ensureAppConfig(companyId);
  return {
    enabled: Boolean(config.cancellationGroupEnabled),
    groupId: normalizeString(config.cancellationGroupId),
    groupName: normalizeString(config.cancellationGroupName),
    dailyAvailabilityDigestEnabled: Boolean(config.dailyAvailabilityDigestEnabled),
    dailyAvailabilityDigestHour: normalizeDailyAvailabilityDigestHour(
      config.dailyAvailabilityDigestHour,
    ),
    dailyAvailabilityDigestLastSentDate: normalizeString(
      config.dailyAvailabilityDigestLastSentDate,
    ),
    dailyAvailabilityDigestFormat: normalizeDailyAvailabilityDigestFormat(
      config.dailyAvailabilityDigestFormat,
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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

const setDailyAvailabilityDigestStatus = async (settings, companyId = null) => {
  const config = await ensureAppConfig(companyId);
  const hasSettingsObject =
    settings && typeof settings === "object" && !Array.isArray(settings);
  const nextEnabled = hasSettingsObject
    ? Boolean(
        typeof settings.enabled === "boolean"
          ? settings.enabled
          : config.dailyAvailabilityDigestEnabled,
      )
    : Boolean(settings);
  const nextHour = hasSettingsObject
    ? normalizeDailyAvailabilityDigestHour(
        typeof settings.hour === "string"
          ? settings.hour
          : config.dailyAvailabilityDigestHour,
      )
    : normalizeDailyAvailabilityDigestHour(config.dailyAvailabilityDigestHour);
  const nextFormat = hasSettingsObject
    ? normalizeDailyAvailabilityDigestFormat(
        typeof settings.format === "string"
          ? settings.format
          : config.dailyAvailabilityDigestFormat,
      )
    : normalizeDailyAvailabilityDigestFormat(config.dailyAvailabilityDigestFormat);

  return AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    {
      $set: {
        dailyAvailabilityDigestEnabled: nextEnabled,
        dailyAvailabilityDigestHour: nextHour,
        dailyAvailabilityDigestFormat: nextFormat,
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

module.exports = {
  DEFAULT_ATTENDANCE_RESPONSE_TIMEOUT_MINUTES,
  DEFAULT_ATTENDANCE_REMINDER_LEAD_MINUTES,
  DEFAULT_CANCELLATION_LOCK_HOURS,
  DEFAULT_DAILY_AVAILABILITY_DIGEST_HOUR,
  DEFAULT_DEPOSIT_AMOUNT,
  DEFAULT_DEPOSIT_ENABLED,
  DEFAULT_HOLD_MINUTES,
  MAX_DEPOSIT_AMOUNT,
  MAX_HOLD_MINUTES,
  DEFAULT_PENALTY_LIMIT,
  DEFAULT_PENALTY_SYSTEM_ENABLED,
  DEFAULT_STRICT_QUESTION_FLOW_ENABLED,
  DEFAULT_TRUSTED_CLIENT_CONFIRMATION_COUNT,
  getCancellationLockHours,
  ensureAppConfig,
  getAttendanceReminderLeadMinutes,
  getAttendanceResponseTimeoutMinutes,
  getOneHourReminderEnabled,
  getPenaltyLimit,
  getPenaltySystemEnabled,
  getStrictQuestionFlowEnabled,
  getTrustedClientConfirmationCount,
  getWhatsappEnabled,
  setCancellationLockHours,
  setAttendanceReminderLeadMinutes,
  setAttendanceResponseTimeoutMinutes,
  setPenaltyLimit,
  setPenaltySystemEnabled,
  setWhatsappEnabledConfigOnly,
  setStrictQuestionFlowEnabled,
  setOneHourReminderEnabled,
  setTrustedClientConfirmationCount,
  getWhatsappCancellationGroupSettings,
  setWhatsappCancellationGroupSettings,
  setDailyAvailabilityDigestStatus,
  setDailyAvailabilityDigestLastSentDate,
  validateDepositSettings,
  resolveDepositUpdate,
  getDepositSettings,
  setDepositSettings,
};

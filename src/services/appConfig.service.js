const AppConfig = require("../models/appConfig.model");
const { canonicalPhoneKey } = require("./clientVerification.service");

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
const DEFAULT_DEPOSIT_METHOD = "transfer";
const DEPOSIT_METHODS = AppConfig.DEPOSIT_METHODS;
const MAX_DEPOSIT_ALIAS = AppConfig.MAX_DEPOSIT_ALIAS;
const MAX_DEPOSIT_CBU = AppConfig.MAX_DEPOSIT_CBU;
const MAX_DEPOSIT_HOLDER = AppConfig.MAX_DEPOSIT_HOLDER;
const DEPOSIT_FIELDS = [
  "depositEnabled",
  "depositAmount",
  "holdMinutes",
  "depositMethod",
  "depositAlias",
  "depositCbu",
  "depositHolder",
];

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

const normalizeDepositMethod = (value) =>
  DEPOSIT_METHODS.includes(value) ? value : DEFAULT_DEPOSIT_METHOD;

const normalizeDepositText = (value, maxLength) => {
  const normalized = normalizeString(value);
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
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
    depositMethod: normalizeDepositMethod(current?.depositMethod),
    depositAlias: normalizeDepositText(current?.depositAlias, MAX_DEPOSIT_ALIAS),
    depositCbu: normalizeDepositText(current?.depositCbu, MAX_DEPOSIT_CBU),
    depositHolder: normalizeDepositText(
      current?.depositHolder,
      MAX_DEPOSIT_HOLDER,
    ),
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

  if (provided.includes("depositMethod")) {
    if (!DEPOSIT_METHODS.includes(source.depositMethod)) {
      return {
        valid: false,
        error: `depositMethod must be one of: ${DEPOSIT_METHODS.join(", ")}.`,
        provided,
        value,
      };
    }
    value.depositMethod = source.depositMethod;
  }

  if (provided.includes("depositAlias")) {
    const alias = normalizeString(source.depositAlias);
    if (alias.length > MAX_DEPOSIT_ALIAS) {
      return {
        valid: false,
        error: `depositAlias must be at most ${MAX_DEPOSIT_ALIAS} characters.`,
        provided,
        value,
      };
    }
    value.depositAlias = alias;
  }

  if (provided.includes("depositCbu")) {
    const cbu = normalizeString(source.depositCbu);
    if (cbu.length > MAX_DEPOSIT_CBU) {
      return {
        valid: false,
        error: `depositCbu must be at most ${MAX_DEPOSIT_CBU} characters.`,
        provided,
        value,
      };
    }
    value.depositCbu = cbu;
  }

  if (provided.includes("depositHolder")) {
    const holder = normalizeString(source.depositHolder);
    if (holder.length > MAX_DEPOSIT_HOLDER) {
      return {
        valid: false,
        error: `depositHolder must be at most ${MAX_DEPOSIT_HOLDER} characters.`,
        provided,
        value,
      };
    }
    value.depositHolder = holder;
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

// Canonicalizes a stored exempt-phone list: every entry runs through
// `canonicalPhoneKey` (funnel rule) and duplicates collapse. Missing/unknown
// values degrade to an empty list so reads never crash on legacy docs.
const canonicalizeExemptPhones = (value) => {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  for (const phone of value) {
    const key = canonicalPhoneKey(phone);
    if (key) seen.add(key);
  }
  return [...seen];
};

// PURE: a phone is exempt only when `normalizedPhones` is an array containing
// its canonical key. Both the list entries and the lookup phone run through
// `canonicalPhoneKey`, so the 54/549 variants match at every layer (including
// callers that hand in a not-yet-canonicalized list). A missing/non-array list
// is never exempt (safe default).
const isPhoneExempt = (normalizedPhones, phone) => {
  if (!Array.isArray(normalizedPhones)) return false;
  const key = canonicalPhoneKey(phone);
  if (!key) return false;
  return normalizedPhones.some((entry) => canonicalPhoneKey(entry) === key);
};

const assertExemptPhone = (phone) => {
  const canonical = canonicalPhoneKey(phone);
  // Same floor as the phone-edit guard: keys shorter than 7 digits cannot be a
  // real number and must never become an exemption.
  if (!canonical || canonical.length < 7) {
    const validationError = new Error(
      "A valid phone number is required for the exemption.",
    );
    validationError.statusCode = 400;
    throw validationError;
  }
  return canonical;
};

const getDepositExemptPhones = async (companyId = null, options = {}) => {
  const config = await resolveConfigModel(options).findOne(
    buildConfigFilter(companyId),
  );
  return canonicalizeExemptPhones(config?.depositExemptPhones);
};

// Atomic add ($addToSet): the phone is canonicalized before persisting so a
// later read always sees the same key regardless of the 54/549 variant used.
const addDepositExemptPhone = async (companyId = null, phone, options = {}) => {
  const canonical = assertExemptPhone(phone);
  const config = await resolveConfigModel(options).findOneAndUpdate(
    buildConfigFilter(companyId),
    { $addToSet: { depositExemptPhones: canonical } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  return canonicalizeExemptPhones(config?.depositExemptPhones);
};

// Atomic remove ($pull). No upsert: removing from a missing config is a no-op.
const removeDepositExemptPhone = async (companyId = null, phone, options = {}) => {
  const canonical = assertExemptPhone(phone);
  const config = await resolveConfigModel(options).findOneAndUpdate(
    buildConfigFilter(companyId),
    { $pull: { depositExemptPhones: canonical } },
    { returnDocument: "after" },
  );
  return canonicalizeExemptPhones(config?.depositExemptPhones);
};

// Loads the company exempt list and delegates to the pure `isPhoneExempt`.
const isDepositExempt = async (companyId = null, phone, options = {}) => {
  const phones = await getDepositExemptPhones(companyId, options);
  return isPhoneExempt(phones, phone);
};

const getDepositSettings = async (companyId = null, options = {}) => {
  const config = await resolveConfigModel(options).findOne(
    buildConfigFilter(companyId),
  );
  return {
    depositEnabled: Boolean(config?.depositEnabled),
    depositAmount: normalizeDepositAmount(config?.depositAmount),
    holdMinutes: normalizeHoldMinutes(config?.holdMinutes),
    depositMethod: normalizeDepositMethod(config?.depositMethod),
    depositAlias: normalizeDepositText(config?.depositAlias, MAX_DEPOSIT_ALIAS),
    depositCbu: normalizeDepositText(config?.depositCbu, MAX_DEPOSIT_CBU),
    depositHolder: normalizeDepositText(
      config?.depositHolder,
      MAX_DEPOSIT_HOLDER,
    ),
    depositExemptPhones: canonicalizeExemptPhones(
      config?.depositExemptPhones,
    ),
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
  DEFAULT_DEPOSIT_METHOD,
  DEFAULT_HOLD_MINUTES,
  DEPOSIT_METHODS,
  MAX_DEPOSIT_ALIAS,
  MAX_DEPOSIT_CBU,
  MAX_DEPOSIT_HOLDER,
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
  getDepositExemptPhones,
  addDepositExemptPhone,
  removeDepositExemptPhone,
  isDepositExempt,
  isPhoneExempt,
};

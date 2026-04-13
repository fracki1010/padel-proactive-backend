const AppConfig = require("../models/appConfig.model");

const CONFIG_KEY = "main";
const DEFAULT_PENALTY_LIMIT = 2;

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
    penaltyLimit: DEFAULT_PENALTY_LIMIT,
    cancellationGroupEnabled: false,
    cancellationGroupId: "",
    cancellationGroupName: "",
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
  DEFAULT_PENALTY_LIMIT,
  ensureAppConfig,
  getOneHourReminderEnabled,
  getPenaltyLimit,
  setPenaltyLimit,
  setOneHourReminderEnabled,
  getWhatsappCancellationGroupSettings,
  setWhatsappCancellationGroupSettings,
  setDailyAvailabilityDigestStatus,
  setDailyAvailabilityDigestLastSentDate,
};

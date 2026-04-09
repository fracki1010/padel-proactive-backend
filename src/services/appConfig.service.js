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

const ensureAppConfig = async (companyId = null) => {
  const existing = await AppConfig.findOne(buildConfigFilter(companyId));
  if (existing) return existing;

  return AppConfig.create({
    companyId: companyId || null,
    key: CONFIG_KEY,
    whatsappEnabled: false,
    penaltyLimit: DEFAULT_PENALTY_LIMIT,
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

module.exports = {
  DEFAULT_PENALTY_LIMIT,
  ensureAppConfig,
  getPenaltyLimit,
  setPenaltyLimit,
};

const WhatsappGroupsSnapshot = require("../models/whatsappGroupsSnapshot.model");

const normalizeCompanyId = (companyId = null) => companyId || null;

const normalizeGroups = (groups = []) => {
  if (!Array.isArray(groups)) return [];

  return groups
    .map((group) => ({
      id: String(group?.id || "").trim(),
      name: String(group?.name || "").trim(),
    }))
    .filter((group) => group.id.endsWith("@g.us"));
};

const getWhatsappGroupsSnapshot = async (companyId = null) => {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  const snapshot = await WhatsappGroupsSnapshot.findOne({
    companyId: normalizedCompanyId,
  }).lean();

  if (!snapshot) {
    return {
      groups: [],
      refreshedAt: null,
    };
  }

  return {
    groups: normalizeGroups(snapshot.groups),
    refreshedAt: snapshot.refreshedAt || null,
  };
};

const saveWhatsappGroupsSnapshot = async (
  companyId = null,
  groups = [],
  refreshedAt = new Date(),
) => {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  const normalizedGroups = normalizeGroups(groups);

  await WhatsappGroupsSnapshot.findOneAndUpdate(
    { companyId: normalizedCompanyId },
    {
      $set: {
        companyId: normalizedCompanyId,
        groups: normalizedGroups,
        refreshedAt: refreshedAt instanceof Date ? refreshedAt : new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return {
    groups: normalizedGroups,
    refreshedAt,
  };
};

module.exports = {
  getWhatsappGroupsSnapshot,
  saveWhatsappGroupsSnapshot,
};

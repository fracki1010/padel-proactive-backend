const Announcement = require("../models/announcement.model");
const { tenantFilter } = require("../middleware/auth.middleware");
const {
  validateAnnouncementInput,
} = require("../services/announcement.service");

// Writes are always scoped to the admin's club. A user without a company
// (e.g. super_admin, which has no tenant) cannot create or mutate notices.
const resolveCompanyScope = (req, res) => {
  const scope = tenantFilter(req);
  if (!scope.companyId) {
    res
      .status(403)
      .json({ success: false, error: "El usuario no tiene una empresa asignada" });
    return null;
  }
  return scope;
};

// GET /api/announcements
const listAnnouncements = async (req, res) => {
  try {
    const announcements = await Announcement.find(tenantFilter(req)).sort({
      order: 1,
      createdAt: -1,
    });
    return res.status(200).json({ success: true, data: announcements });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// POST /api/announcements
const createAnnouncement = async (req, res) => {
  try {
    const scope = resolveCompanyScope(req, res);
    if (!scope) return undefined;

    const { data, errors } = validateAnnouncementInput(req.body || {});
    if (errors.length) {
      return res.status(400).json({ success: false, error: errors[0] });
    }

    const announcement = await Announcement.create({ ...scope, ...data });
    return res.status(201).json({ success: true, data: announcement });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// PUT /api/announcements/:id
const updateAnnouncement = async (req, res) => {
  try {
    const scope = resolveCompanyScope(req, res);
    if (!scope) return undefined;

    const { data, errors } = validateAnnouncementInput(req.body || {}, {
      partial: true,
    });
    if (errors.length) {
      return res.status(400).json({ success: false, error: errors[0] });
    }

    const announcement = await Announcement.findOneAndUpdate(
      { _id: req.params.id, ...scope },
      data,
      { returnDocument: "after", runValidators: true },
    );

    if (!announcement) {
      return res
        .status(404)
        .json({ success: false, error: "Aviso no encontrado." });
    }

    return res.status(200).json({ success: true, data: announcement });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// DELETE /api/announcements/:id
const deleteAnnouncement = async (req, res) => {
  try {
    const scope = resolveCompanyScope(req, res);
    if (!scope) return undefined;

    const announcement = await Announcement.findOneAndDelete({
      _id: req.params.id,
      ...scope,
    });

    if (!announcement) {
      return res
        .status(404)
        .json({ success: false, error: "Aviso no encontrado." });
    }

    return res.status(200).json({ success: true, data: { _id: req.params.id } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// PATCH /api/announcements/:id/toggle
const toggleAnnouncement = async (req, res) => {
  try {
    const scope = resolveCompanyScope(req, res);
    if (!scope) return undefined;

    const announcement = await Announcement.findOne({
      _id: req.params.id,
      ...scope,
    });

    if (!announcement) {
      return res
        .status(404)
        .json({ success: false, error: "Aviso no encontrado." });
    }

    announcement.isActive = !announcement.isActive;
    await announcement.save();

    return res.status(200).json({ success: true, data: announcement });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  listAnnouncements,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
  toggleAnnouncement,
};

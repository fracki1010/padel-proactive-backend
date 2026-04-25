const Admin = require("../models/admin.model");
const Company = require("../models/company.model");
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const Booking = require("../models/booking.model");
const User = require("../models/user.model");
const Notification = require("../models/notification.model");
const AppConfig = require("../models/appConfig.model");

const normalizeSlug = (value = "") =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const normalizeAddress = (value = "") => String(value || "").trim();

const listCompanies = async (_req, res) => {
  try {
    const companies = await Company.find().sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: companies });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const createCompany = async (req, res) => {
  try {
    const { name, slug, address } = req.body;

    if (!name || !String(name).trim()) {
      return res
        .status(400)
        .json({ success: false, error: "El nombre de la empresa es obligatorio." });
    }

    const cleanName = String(name).trim();
    const cleanSlug = normalizeSlug(slug || cleanName);
    const cleanAddress = normalizeAddress(address);

    if (!cleanSlug) {
      return res.status(400).json({
        success: false,
        error: "No se pudo generar un slug válido para la empresa.",
      });
    }

    const existing = await Company.findOne({
      $or: [{ name: cleanName }, { slug: cleanSlug }],
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        error: "Ya existe una empresa con ese nombre o slug.",
      });
    }

    const company = await Company.create({
      name: cleanName,
      slug: cleanSlug,
      address: cleanAddress,
    });
    return res.status(201).json({ success: true, data: company });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const updateCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const payload = req.body || {};
    const nextName = Object.prototype.hasOwnProperty.call(payload, "name")
      ? String(payload.name || "").trim()
      : null;
    const nextSlugRaw = Object.prototype.hasOwnProperty.call(payload, "slug")
      ? String(payload.slug || "").trim()
      : null;
    const nextAddress = Object.prototype.hasOwnProperty.call(payload, "address")
      ? normalizeAddress(payload.address)
      : null;
    const nextCoverImage = Object.prototype.hasOwnProperty.call(payload, "coverImage")
      ? String(payload.coverImage || "").trim()
      : null;

    const hasName = nextName !== null;
    const hasSlug = nextSlugRaw !== null;
    const hasAddress = nextAddress !== null;
    const hasCoverImage = nextCoverImage !== null;

    if (!hasName && !hasSlug && !hasAddress && !hasCoverImage) {
      return res.status(400).json({
        success: false,
        error: "Debés enviar al menos uno de estos campos: name, slug, address, coverImage.",
      });
    }

    const company = await Company.findById(id);
    if (!company) {
      return res
        .status(404)
        .json({ success: false, error: "Empresa no encontrada." });
    }

    const updates = {};

    if (hasName || hasSlug) {
      const finalName = hasName ? nextName : company.name;
      let finalSlug = hasSlug ? normalizeSlug(nextSlugRaw) : company.slug;

      if (hasName && !nextName) {
        return res.status(400).json({
          success: false,
          error: "El nombre de la empresa no puede quedar vacío.",
        });
      }

      if (!finalSlug && finalName) {
        finalSlug = normalizeSlug(finalName);
      }

      if (!finalSlug) {
        return res.status(400).json({
          success: false,
          error: "No se pudo generar un slug válido para la empresa.",
        });
      }

      const duplicate = await Company.findOne({
        _id: { $ne: id },
        $or: [{ name: finalName }, { slug: finalSlug }],
      }).lean();

      if (duplicate) {
        return res.status(400).json({
          success: false,
          error: "Ya existe una empresa con ese nombre o slug.",
        });
      }

      updates.name = finalName;
      updates.slug = finalSlug;
    }

    if (hasAddress) updates.address = nextAddress;
    if (hasCoverImage) updates.coverImage = nextCoverImage;

    const updated = await Company.findByIdAndUpdate(id, { $set: updates }, { returnDocument: "after" });
    return res.status(200).json({ success: true, data: updated });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const updateCompanyStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "El campo 'isActive' debe ser booleano.",
      });
    }

    const company = await Company.findByIdAndUpdate(
      id,
      { $set: { isActive } },
      { returnDocument: "after" },
    );

    if (!company) {
      return res
        .status(404)
        .json({ success: false, error: "Empresa no encontrada." });
    }

    await Admin.updateMany(
      { companyId: company._id, role: { $ne: "super_admin" } },
      { $set: { isActive } },
    );

    return res.status(200).json({ success: true, data: company });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const listAdmins = async (req, res) => {
  try {
    const { companyId } = req.query;
    const filter = {};

    if (companyId) filter.companyId = companyId;

    const admins = await Admin.find(filter)
      .select("-password")
      .populate("companyId", "name slug address isActive")
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, data: admins });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const createAdmin = async (req, res) => {
  try {
    const { username, password, phone, companyId, role = "admin" } = req.body;

    if (!username || !password || !companyId) {
      return res.status(400).json({
        success: false,
        error: "username, password y companyId son obligatorios.",
      });
    }

    const normalizedRole = String(role);
    if (!["admin", "manager"].includes(normalizedRole)) {
      return res.status(400).json({
        success: false,
        error: "El rol permitido para alta es 'admin' o 'manager'.",
      });
    }

    const company = await Company.findById(companyId);
    if (!company) {
      return res
        .status(404)
        .json({ success: false, error: "Empresa no encontrada." });
    }

    if (!company.isActive) {
      return res.status(400).json({
        success: false,
        error: "No se puede crear admin en una empresa desactivada.",
      });
    }

    const existingAdmin = await Admin.findOne({ username: String(username).trim() });
    if (existingAdmin) {
      return res
        .status(400)
        .json({ success: false, error: "El usuario ya existe" });
    }

    const admin = await Admin.create({
      username: String(username).trim(),
      password: String(password),
      phone: phone ? String(phone).trim() : "",
      companyId: company._id,
      role: normalizedRole,
      isActive: true,
    });

    const populatedAdmin = await Admin.findById(admin._id)
      .select("-password")
      .populate("companyId", "name slug address isActive");

    return res.status(201).json({ success: true, data: populatedAdmin });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({
        success: false,
        error: "El usuario ya existe.",
      });
    }
    return res.status(500).json({ success: false, error: error.message });
  }
};

const updateAdminStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    if (typeof isActive !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "El campo 'isActive' debe ser booleano.",
      });
    }

    const admin = await Admin.findById(id);
    if (!admin) {
      return res
        .status(404)
        .json({ success: false, error: "Admin no encontrado." });
    }

    if (admin.role === "super_admin") {
      return res.status(400).json({
        success: false,
        error: "No se puede desactivar un super admin por esta vía.",
      });
    }

    admin.isActive = isActive;
    await admin.save();

    const populatedAdmin = await Admin.findById(id)
      .select("-password")
      .populate("companyId", "name slug address isActive");

    return res.status(200).json({ success: true, data: populatedAdmin });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const bootstrapDefaultTenant = async (req, res) => {
  try {
    const {
      name = "Mi Club",
      slug,
      assignAllUnassignedData = true,
      assignAllUnassignedAdmins = true,
    } = req.body || {};

    const cleanName = String(name).trim();
    const cleanSlug = normalizeSlug(slug || cleanName);

    if (!cleanName || !cleanSlug) {
      return res.status(400).json({
        success: false,
        error: "Debés enviar un nombre válido para la empresa.",
      });
    }

    let company = await Company.findOne({ slug: cleanSlug });
    if (!company) {
      company = await Company.create({ name: cleanName, slug: cleanSlug });
    }

    const companyId = company._id;
    const summary = {};

    if (assignAllUnassignedData) {
      const [courts, slots, bookings, users, notifications, configs] =
        await Promise.all([
          Court.updateMany({ companyId: null }, { $set: { companyId } }),
          TimeSlot.updateMany({ companyId: null }, { $set: { companyId } }),
          Booking.updateMany({ companyId: null }, { $set: { companyId } }),
          User.updateMany({ companyId: null }, { $set: { companyId } }),
          Notification.updateMany({ companyId: null }, { $set: { companyId } }),
          AppConfig.updateMany({ companyId: null }, { $set: { companyId } }),
        ]);

      summary.data = {
        courts: courts.modifiedCount || 0,
        slots: slots.modifiedCount || 0,
        bookings: bookings.modifiedCount || 0,
        users: users.modifiedCount || 0,
        notifications: notifications.modifiedCount || 0,
        appConfig: configs.modifiedCount || 0,
      };
    }

    if (assignAllUnassignedAdmins) {
      const admins = await Admin.updateMany(
        {
          role: { $in: ["admin", "manager"] },
          companyId: null,
        },
        { $set: { companyId, isActive: true } },
      );
      summary.admins = { assigned: admins.modifiedCount || 0 };
    }

    return res.status(200).json({
      success: true,
      data: {
        company,
        summary,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  listCompanies,
  createCompany,
  updateCompany,
  updateCompanyStatus,
  listAdmins,
  createAdmin,
  updateAdminStatus,
  bootstrapDefaultTenant,
};

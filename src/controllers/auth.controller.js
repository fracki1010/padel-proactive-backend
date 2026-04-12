// src/controllers/auth.controller.js
const Admin = require("../models/admin.model");
const Company = require("../models/company.model");
const jwt = require("jsonwebtoken");

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "365d";
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

const normalizeSlug = (value = "") =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const buildAuthUser = (admin) => ({
  id: admin._id,
  username: admin.username,
  role: admin.role,
  phone: admin.phone,
  companyId: admin.companyId || null,
  isActive: admin.isActive,
});

const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    const admin = await Admin.findOne({ username }).populate(
      "companyId",
      "name slug address isActive",
    );
    if (!admin) {
      return res
        .status(401)
        .json({ success: false, error: "Credenciales inválidas" });
    }

    if (admin.isActive === false) {
      return res.status(403).json({
        success: false,
        error: "Tu cuenta está desactivada. Contactá al super admin.",
      });
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, error: "Credenciales inválidas" });
    }

    const token = jwt.sign(
      {
        id: admin._id,
        username: admin.username,
        role: admin.role,
        companyId: admin.companyId?._id || null,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    );

    res.status(200).json({
      success: true,
      data: {
        token,
        user: buildAuthUser(admin),
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const register = async (req, res) => {
  return res.status(403).json({
    success: false,
    error: "Registro público deshabilitado. El alta la realiza un super admin.",
  });
};

const me = async (req, res) => {
  try {
    const admin = await Admin.findById(req.user.id)
      .select("-password")
      .populate("companyId", "name slug address isActive");

    if (!admin) {
      return res.status(404).json({
        success: false,
        error: "Usuario no encontrado",
      });
    }

    res.status(200).json({ success: true, data: admin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { username, phone } = req.body;

    const payload = {};
    if (typeof username === "string" && username.trim()) {
      payload.username = username.trim();
    }
    if (typeof phone === "string") {
      payload.phone = phone.trim();
    }

    const admin = await Admin.findByIdAndUpdate(
      req.user.id,
      { $set: payload },
      { new: true, runValidators: true },
    )
      .select("-password")
      .populate("companyId", "name slug address isActive");

    res.status(200).json({ success: true, data: admin });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({
        success: false,
        error: "El nombre de usuario ya está en uso.",
      });
    }
    res.status(500).json({ success: false, error: error.message });
  }
};

const updateMyCompany = async (req, res) => {
  try {
    if (!req.user?.companyId) {
      return res.status(403).json({
        success: false,
        error: "No tenés una empresa asignada.",
      });
    }

    const payload = req.body || {};
    const nextName = Object.prototype.hasOwnProperty.call(payload, "name")
      ? String(payload.name || "").trim()
      : null;
    const nextSlugRaw = Object.prototype.hasOwnProperty.call(payload, "slug")
      ? String(payload.slug || "").trim()
      : null;
    const nextAddress = Object.prototype.hasOwnProperty.call(payload, "address")
      ? String(payload.address || "").trim()
      : null;

    const hasName = nextName !== null;
    const hasSlug = nextSlugRaw !== null;
    const hasAddress = nextAddress !== null;

    if (!hasName && !hasSlug && !hasAddress) {
      return res.status(400).json({
        success: false,
        error: "Debés enviar al menos uno de estos campos: name, slug, address.",
      });
    }

    const company = await Company.findById(req.user.companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        error: "Empresa no encontrada.",
      });
    }

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
      _id: { $ne: company._id },
      $or: [{ name: finalName }, { slug: finalSlug }],
    }).lean();

    if (duplicate) {
      return res.status(400).json({
        success: false,
        error: "Ya existe una empresa con ese nombre o slug.",
      });
    }

    if (hasName) company.name = finalName;
    if (hasSlug || (hasName && !hasSlug)) company.slug = finalSlug;
    if (hasAddress) company.address = nextAddress;
    await company.save();

    const admin = await Admin.findById(req.user.id)
      .select("-password")
      .populate("companyId", "name slug address isActive");

    return res.status(200).json({
      success: true,
      data: {
        company,
        user: admin,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  login,
  register,
  me,
  updateProfile,
  updateMyCompany,
};

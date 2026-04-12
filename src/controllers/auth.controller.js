// src/controllers/auth.controller.js
const Admin = require("../models/admin.model");
const jwt = require("jsonwebtoken");

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "365d";
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

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

module.exports = {
  login,
  register,
  me,
  updateProfile,
};

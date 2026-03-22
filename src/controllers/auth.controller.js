// src/controllers/auth.controller.js
const Admin = require("../models/admin.model");
const jwt = require("jsonwebtoken");

const login = async (req, res) => {
  try {
    const { username, password } = req.body;

    const admin = await Admin.findOne({ username });
    if (!admin) {
      return res
        .status(401)
        .json({ success: false, error: "Credenciales inválidas" });
    }

    const isMatch = await admin.comparePassword(password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, error: "Credenciales inválidas" });
    }

    const token = jwt.sign(
      { id: admin._id, username: admin.username, role: admin.role },
      process.env.JWT_SECRET || "fallback_secret",
      { expiresIn: "24h" },
    );

    res.status(200).json({
      success: true,
      data: {
        token,
        user: {
          id: admin._id,
          username: admin.username,
          role: admin.role,
          phone: admin.phone,
        },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const register = async (req, res) => {
  try {
    const { username, password, role, phone } = req.body;

    const existingAdmin = await Admin.findOne({ username });
    if (existingAdmin) {
      return res
        .status(400)
        .json({ success: false, error: "El usuario ya existe" });
    }

    const admin = await Admin.create({ username, password, role, phone });

    res.status(201).json({
      success: true,
      data: {
        id: admin._id,
        username: admin.username,
        role: admin.role,
        phone: admin.phone,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const me = async (req, res) => {
  try {
    const admin = await Admin.findById(req.user.id).select("-password");
    res.status(200).json({ success: true, data: admin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const updateProfile = async (req, res) => {
  try {
    const { username, phone } = req.body;
    const admin = await Admin.findByIdAndUpdate(
      req.user.id,
      { $set: { username, phone } },
      { new: true, runValidators: true },
    ).select("-password");

    res.status(200).json({ success: true, data: admin });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  login,
  register,
  me,
  updateProfile,
};

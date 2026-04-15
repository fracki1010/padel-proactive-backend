const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const toIsoDateOnly = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toISOString().slice(0, 10);
};

const resolveCompanyId = (req) => {
  if (req.user?.role === "super_admin") {
    return req.query.companyId || req.body.companyId || null;
  }
  return req.user?.companyId || null;
};

const companyScope = (req, companyId) => {
  if (req.user?.role === "super_admin") {
    return companyId ? { companyId } : {};
  }
  return { companyId: req.user?.companyId || null };
};

const getUsers = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const users = await User.find(companyScope(req, companyId)).sort({ name: 1 });
    res.status(200).json({
      success: true,
      count: users.length,
      data: users,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const createUser = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const user = await User.create({
      ...req.body,
      ...companyScope(req, companyId),
    });
    res.status(201).json({ success: true, data: user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

const updateUser = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, ...companyScope(req, companyId) },
      req.body,
      { returnDocument: "after", runValidators: true },
    );
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "Usuario no encontrado" });
    }
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

const deleteUser = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const user = await User.findOneAndDelete({
      _id: req.params.id,
      ...companyScope(req, companyId),
    });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "Usuario no encontrado" });
    }
    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

const getUserHistory = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const user = await User.findOne({
      _id: req.params.id,
      ...companyScope(req, companyId),
    });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "Usuario no encontrado" });
    }

    // Buscamos las reservas por nombre o teléfono, ya que el modelo Booking no tiene referencia directa aún
    // Pero idealmente deberíamos buscarlas por phoneNumber que es más estable
    const bookings = await Booking.find({
      ...companyScope(req, companyId),
      $or: [{ clientPhone: user.phoneNumber }, { clientName: user.name }],
    })
      .populate("court")
      .populate("timeSlot")
      .sort({ date: -1 });

    const normalizedBookings = bookings.map((booking) => ({
      ...(typeof booking.toObject === "function" ? booking.toObject() : booking),
      date: toIsoDateOnly(booking.date),
    }));

    res.status(200).json({ success: true, data: normalizedBookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const clearPenalties = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, ...companyScope(req, companyId) },
      { penalties: 0, isSuspended: false },
      { returnDocument: "after" },
    );
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "Usuario no encontrado" });
    }
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

module.exports = {
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  getUserHistory,
  clearPenalties,
};

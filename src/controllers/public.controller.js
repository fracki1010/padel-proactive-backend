const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const Company = require("../models/company.model");
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const Booking = require("../models/booking.model");
const ClubClosure = require("../models/clubClosure.model");
const ClientAccount = require("../models/clientAccount.model");
const {
  materializeFixedBookingsForDate,
} = require("../services/fixedTurnsMaterialization.service");

const JWT_SECRET = process.env.JWT_SECRET;

const verifyFirebaseIdToken = async (idToken) => {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error("FIREBASE_API_KEY no configurado en el backend");
  const { data } = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    { idToken },
  );
  const user = data?.users?.[0];
  if (!user) throw new Error("Token de Google inválido");
  return { email: user.email, name: user.displayName || "", photo: user.photoUrl || "" };
};

const toIsoDateOnly = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toISOString().slice(0, 10);
};

const parseDateToUtcMidnight = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCHours(0, 0, 0, 0);
  return parsed;
};

const resolveCompany = async (slug) => {
  if (!slug) return null;
  return Company.findOne({ slug: slug.toLowerCase(), isActive: true });
};

// GET /api/public/:slug
const getClubInfo = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const [courts, slots] = await Promise.all([
      Court.find({ companyId: company._id, isActive: true }).sort({ name: 1 }),
      TimeSlot.find({ companyId: company._id, isActive: true }).sort({ order: 1, startTime: 1 }),
    ]);

    return res.json({
      success: true,
      data: {
        club: { name: company.name, address: company.address },
        courts,
        slots,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// GET /api/public/:slug/availability?date=YYYY-MM-DD
const getAvailability = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const { date } = req.query;
    if (!date) {
      return res.status(400).json({ success: false, error: "Parámetro 'date' requerido" });
    }

    const searchDate = parseDateToUtcMidnight(date);
    if (!searchDate) {
      return res.status(400).json({ success: false, error: "Fecha inválida" });
    }

    // Verificar cierre del club
    const closure = await ClubClosure.findOne({
      companyId: company._id,
      date: searchDate,
    });

    if (closure) {
      return res.json({
        success: true,
        data: {
          closed: true,
          closureReason: closure.reason || "El club está cerrado ese día",
          courts: [],
          slots: [],
          bookings: [],
        },
      });
    }

    await materializeFixedBookingsForDate({
      companyId: company._id,
      searchDate,
    });

    const [courts, slots, bookings] = await Promise.all([
      Court.find({ companyId: company._id, isActive: true }).sort({ name: 1 }),
      TimeSlot.find({ companyId: company._id, isActive: true }).sort({ order: 1, startTime: 1 }),
      Booking.find({
        companyId: company._id,
        date: searchDate,
        status: { $nin: ["cancelado"] },
      }).select("court timeSlot status"),
    ]);

    const occupiedSet = new Set(
      bookings.map((b) => `${String(b.court)}_${String(b.timeSlot)}`),
    );

    const availability = courts.flatMap((court) =>
      slots.map((slot) => ({
        courtId: String(court._id),
        slotId: String(slot._id),
        available: !occupiedSet.has(`${String(court._id)}_${String(slot._id)}`),
      })),
    );

    return res.json({
      success: true,
      data: {
        closed: false,
        courts,
        slots,
        availability,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// POST /api/public/:slug/auth/register
const registerClient = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const { name, email, phone, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: "Nombre, email y contraseña son requeridos" });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: "La contraseña debe tener al menos 6 caracteres" });
    }

    const existing = await ClientAccount.findOne({
      companyId: company._id,
      email: email.toLowerCase().trim(),
    });

    if (existing) {
      return res.status(409).json({ success: false, error: "Ya existe una cuenta con ese email" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await ClientAccount.create({
      companyId: company._id,
      name: name.trim(),
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      passwordHash,
    });

    const token = jwt.sign(
      {
        id: client._id,
        email: client.email,
        companyId: company._id,
        type: "client",
      },
      JWT_SECRET,
      { expiresIn: "30d" },
    );

    return res.status(201).json({
      success: true,
      data: {
        token,
        client: { id: client._id, name: client.name, email: client.email, phone: client.phone },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// POST /api/public/:slug/auth/login
const loginClient = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: "Email y contraseña requeridos" });
    }

    const client = await ClientAccount.findOne({
      companyId: company._id,
      email: email.toLowerCase().trim(),
      isActive: true,
    });

    if (!client) {
      return res.status(401).json({ success: false, error: "Email o contraseña incorrectos" });
    }

    const valid = await bcrypt.compare(password, client.passwordHash);
    if (!valid) {
      return res.status(401).json({ success: false, error: "Email o contraseña incorrectos" });
    }

    const token = jwt.sign(
      {
        id: client._id,
        email: client.email,
        companyId: company._id,
        type: "client",
      },
      JWT_SECRET,
      { expiresIn: "30d" },
    );

    return res.json({
      success: true,
      data: {
        token,
        client: { id: client._id, name: client.name, email: client.email, phone: client.phone },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// GET /api/public/:slug/auth/me  (requiere protectClient)
const getMe = async (req, res) => {
  try {
    const client = await ClientAccount.findById(req.clientUser.id).select("-passwordHash");
    if (!client || !client.isActive) {
      return res.status(404).json({ success: false, error: "Cuenta no encontrada" });
    }
    return res.json({
      success: true,
      data: { id: client._id, name: client.name, email: client.email, phone: client.phone },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// POST /api/public/:slug/bookings  (requiere protectClient)
const createClientBooking = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    if (String(req.clientUser.companyId) !== String(company._id)) {
      return res.status(403).json({ success: false, error: "No autorizado para este club" });
    }

    const { courtId, slotId, date } = req.body;
    if (!courtId || !slotId || !date) {
      return res.status(400).json({ success: false, error: "Cancha, turno y fecha son requeridos" });
    }

    const searchDate = parseDateToUtcMidnight(date);
    if (!searchDate) {
      return res.status(400).json({ success: false, error: "Fecha inválida" });
    }

    // Verificar cierre del club
    const closure = await ClubClosure.findOne({ companyId: company._id, date: searchDate });
    if (closure) {
      return res.status(409).json({ success: false, error: "El club está cerrado ese día" });
    }

    const [court, slot] = await Promise.all([
      Court.findOne({ _id: courtId, companyId: company._id, isActive: true }),
      TimeSlot.findOne({ _id: slotId, companyId: company._id, isActive: true }),
    ]);

    if (!court) return res.status(404).json({ success: false, error: "Cancha no encontrada" });
    if (!slot) return res.status(404).json({ success: false, error: "Turno no encontrado" });

    await materializeFixedBookingsForDate({ companyId: company._id, searchDate });

    const existing = await Booking.findOne({
      companyId: company._id,
      court: court._id,
      date: searchDate,
      timeSlot: slot._id,
      status: { $nin: ["cancelado"] },
    });

    if (existing) {
      return res.status(409).json({ success: false, error: "Ese turno ya está reservado" });
    }

    const client = await ClientAccount.findById(req.clientUser.id);
    if (!client) return res.status(404).json({ success: false, error: "Cuenta no encontrada" });

    const booking = await Booking.create({
      companyId: company._id,
      court: court._id,
      date: searchDate,
      timeSlot: slot._id,
      clientName: client.name,
      clientPhone: client.phone,
      status: "reservado",
      paymentStatus: "pendiente",
      finalPrice: slot.price || 0,
    });

    const populated = await Booking.findById(booking._id)
      .populate("court")
      .populate("timeSlot");

    return res.status(201).json({
      success: true,
      data: {
        ...populated.toObject(),
        date: toIsoDateOnly(populated.date),
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, error: "Ese turno ya está reservado" });
    }
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// GET /api/public/:slug/bookings  (requiere protectClient)
const getMyBookings = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    if (String(req.clientUser.companyId) !== String(company._id)) {
      return res.status(403).json({ success: false, error: "No autorizado para este club" });
    }

    const client = await ClientAccount.findById(req.clientUser.id);
    if (!client) return res.status(404).json({ success: false, error: "Cuenta no encontrada" });

    const bookings = await Booking.find({
      companyId: company._id,
      clientPhone: client.phone,
      status: { $nin: ["cancelado"] },
      date: { $gte: new Date(new Date().setUTCHours(0, 0, 0, 0)) },
    })
      .populate("court")
      .populate("timeSlot")
      .sort({ date: 1 });

    return res.json({
      success: true,
      data: bookings.map((b) => ({ ...b.toObject(), date: toIsoDateOnly(b.date) })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// DELETE /api/public/:slug/bookings/:id  (requiere protectClient)
const cancelMyBooking = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const client = await ClientAccount.findById(req.clientUser.id);
    if (!client) return res.status(404).json({ success: false, error: "Cuenta no encontrada" });

    const booking = await Booking.findOne({
      _id: req.params.id,
      companyId: company._id,
      clientPhone: client.phone,
    });

    if (!booking) {
      return res.status(404).json({ success: false, error: "Reserva no encontrada" });
    }

    if (booking.status === "cancelado") {
      return res.status(409).json({ success: false, error: "La reserva ya está cancelada" });
    }

    booking.status = "cancelado";
    await booking.save();

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// POST /api/public/:slug/auth/google
const googleAuth = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const { idToken, phone } = req.body;
    if (!idToken) {
      return res.status(400).json({ success: false, error: "idToken requerido" });
    }

    let googleUser;
    try {
      googleUser = await verifyFirebaseIdToken(idToken);
    } catch {
      return res.status(401).json({ success: false, error: "Token de Google inválido" });
    }

    const { email, name } = googleUser;
    if (!email) {
      return res.status(400).json({ success: false, error: "La cuenta de Google no tiene email" });
    }

    let client = await ClientAccount.findOne({
      companyId: company._id,
      email: email.toLowerCase(),
    });

    const isNew = !client;

    if (isNew) {
      // Cuenta nueva: crear con los datos de Google
      client = await ClientAccount.create({
        companyId: company._id,
        name: name || email.split("@")[0],
        email: email.toLowerCase(),
        phone: phone?.trim() || "",
        // Sin password — solo Google auth
        passwordHash: await bcrypt.hash(Math.random().toString(36), 10),
        googleAuth: true,
      });
    } else if (phone && !client.phone) {
      // Cuenta existente sin teléfono: actualizar
      client.phone = phone.trim();
      await client.save();
    }

    const needsPhone = !client.phone;

    const token = jwt.sign(
      { id: client._id, email: client.email, companyId: company._id, type: "client" },
      JWT_SECRET,
      { expiresIn: "30d" },
    );

    return res.status(isNew ? 201 : 200).json({
      success: true,
      data: {
        token,
        client: { id: client._id, name: client.name, email: client.email, phone: client.phone },
        isNew,
        needsPhone,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// PUT /api/public/:slug/auth/me/phone  (requiere protectClient)
const updatePhone = async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone?.trim()) {
      return res.status(400).json({ success: false, error: "Teléfono requerido" });
    }

    const client = await ClientAccount.findByIdAndUpdate(
      req.clientUser.id,
      { phone: phone.trim() },
      { new: true },
    );

    if (!client) return res.status(404).json({ success: false, error: "Cuenta no encontrada" });

    return res.json({
      success: true,
      data: { id: client._id, name: client.name, email: client.email, phone: client.phone },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

module.exports = {
  getClubInfo,
  getAvailability,
  registerClient,
  loginClient,
  getMe,
  updatePhone,
  googleAuth,
  createClientBooking,
  getMyBookings,
  cancelMyBooking,
};

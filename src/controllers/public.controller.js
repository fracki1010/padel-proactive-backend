const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const Company = require("../models/company.model");
const Court = require("../models/court.model");
const TimeSlot = require("../models/timeSlot.model");
const Booking = require("../models/booking.model");
const ClubClosure = require("../models/clubClosure.model");
const ClientAccount = require("../models/clientAccount.model");
const OtpVerification = require("../models/otpVerification.model");
const User = require("../models/user.model");
const {
  materializeFixedBookingsForDate,
} = require("../services/fixedTurnsMaterialization.service");
const { getCancellationContactPhone } = require("../services/bookingService");
const { formatBookingDateShort } = require("../utils/formatBookingDateShort");
const {
  COMMAND_TYPES,
  enqueueWhatsappCommand,
} = require("../services/whatsappCommandQueue.service");
const {
  normalizeCanonicalClientPhone,
} = require("../utils/identityNormalization");
const { getWhatsappIdByPhone } = require("../utils/getWhatsappIdByPhone");
const { getCancellationLockHours } = require("../services/appConfig.service");

const JWT_SECRET = process.env.JWT_SECRET;

const TIMEZONE = "America/Argentina/Buenos_Aires";

// Devuelve la medianoche UTC del día actual en la timezone dada
const todayUtcMidnightInTimezone = (timeZone) => {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = localDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const getMinutesUntilSlotStart = (dateStr, timeStr) => {
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const [hour, minute] = String(timeStr).split(":").map(Number);

  const nowInTz = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const nowH = Number(nowInTz.find((p) => p.type === "hour")?.value || 0);
  const nowM = Number(nowInTz.find((p) => p.type === "minute")?.value || 0);
  const nowMinutes = nowH * 60 + nowM;

  const todayInTz = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const [ty, tm, td] = todayInTz.split("-").map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const targetUtc = Date.UTC(year, month - 1, day);
  const daysDiff = (targetUtc - todayUtc) / (24 * 60 * 60 * 1000);

  return daysDiff * 24 * 60 + hour * 60 + minute - nowMinutes;
};
const OTP_TTL_MINUTES = 10;

// ─── Helpers ────────────────────────────────────────────────────────────────

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

const signClientToken = (client, companyId) =>
  jwt.sign(
    { id: client._id, email: client.email, companyId, type: "client" },
    JWT_SECRET,
    { expiresIn: "30d" },
  );

const clientPayload = (client) => ({
  id: client._id,
  name: client.name,
  email: client.email,
  phone: client.phone,
});

// Argentina: insertar el 9 entre el código de país (54) y el número de área si no está presente
const canonicalizePhone = (digits = "") => {
  if (digits.startsWith("54") && !digits.startsWith("549") && digits.length >= 12) {
    return "549" + digits.slice(2);
  }
  return digits;
};

// Combina countryCode + localNumber, normaliza a solo dígitos y canoniza formato argentino
const buildNormalizedPhone = (countryCode = "", localNumber = "") => {
  const raw = `${countryCode}${localNumber}`;
  return canonicalizePhone(normalizeCanonicalClientPhone(raw));
};

// Query MongoDB que matchea un teléfono en ambos formatos (con y sin el 9 argentino)
// para compatibilidad con registros guardados antes de la canonización
const phoneMatchQuery = (phone = "") => {
  if (phone.startsWith("549") && phone.length >= 13) {
    return { $in: [phone, "54" + phone.slice(3)] };
  }
  return phone;
};

const maskPhone = (digits = "") => {
  if (digits.length < 4) return "****";
  return `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
};

const generateOtp = () =>
  String(Math.floor(100000 + Math.random() * 900000));

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

// ─── Endpoints públicos ──────────────────────────────────────────────────────

// GET /api/public/:slug
const getClubInfo = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const [courts, slots, cancellationLockHours] = await Promise.all([
      Court.find({ companyId: company._id, isActive: true }).sort({ name: 1 }),
      TimeSlot.find({ companyId: company._id, isActive: true }).sort({ order: 1, startTime: 1 }),
      getCancellationLockHours(company._id),
    ]);

    return res.json({
      success: true,
      data: {
        club: { name: company.name, address: company.address, coverImage: company.coverImage || "" },
        courts,
        slots,
        cancellationLockHours,
      },
    });
  } catch {
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

    const closure = await ClubClosure.findOne({ companyId: company._id, date: searchDate });
    if (closure) {
      return res.json({
        success: true,
        data: {
          closed: true,
          closureReason: closure.reason || "El club está cerrado ese día",
          courts: [],
          slots: [],
          availability: [],
        },
      });
    }

    await materializeFixedBookingsForDate({ companyId: company._id, searchDate });

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
      data: { closed: false, courts, slots, availability },
    });
  } catch {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// Devuelve el teléfono del cliente: propio si tiene, o el del User vinculado
const resolveClientPhone = async (client) => {
  if (client.phone) return client.phone;
  if (!client.linkedUserId) return null;
  const user = await User.findById(client.linkedUserId).lean();
  return user?.phoneNumber || null;
};

const findOrCreateLinkedUser = async (companyId, phone, name, resolveWhatsappId = false, origin = "sistema") => {
  const existing = await User.findOne({ companyId, phoneNumber: phoneMatchQuery(phone) });
  if (existing) {
    if (resolveWhatsappId) {
      const realId = await getWhatsappIdByPhone(phone, companyId);
      if (realId && realId !== existing.whatsappId) {
        existing.whatsappId = realId;
        await existing.save();
      }
    }
    return existing;
  }

  const realId = resolveWhatsappId ? await getWhatsappIdByPhone(phone, companyId) : null;
  return await User.create({
    companyId,
    whatsappId: realId || `${phone}@c.us`,
    name,
    phoneNumber: phone,
    accountOrigin: origin,
  });
};

// POST /api/public/:slug/auth/send-otp
const sendOtp = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const { countryCode, localNumber, googleFlow } = req.body;
    if (!countryCode || !localNumber) {
      return res.status(400).json({ success: false, error: "Código de país y número requeridos" });
    }

    const phone = buildNormalizedPhone(countryCode, localNumber);
    if (!phone || phone.length < 7) {
      return res.status(400).json({ success: false, error: "Número de teléfono inválido" });
    }

    if (googleFlow) {
      const existingUser = await User.findOne({ companyId: company._id, phoneNumber: phoneMatchQuery(phone) });
      if (existingUser?.accountOrigin === "google") {
        return res.status(409).json({ success: false, error: "Este número ya está vinculado a una cuenta de Google" });
      }
    } else {
      const phoneTaken = await ClientAccount.findOne({ companyId: company._id, phone: phoneMatchQuery(phone) });
      if (phoneTaken) {
        return res.status(409).json({ success: false, error: "Ya existe una cuenta con ese teléfono" });
      }
    }

    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    // Eliminar OTPs previos para ese número
    await OtpVerification.deleteMany({ companyId: company._id, phone });

    await OtpVerification.create({ companyId: company._id, phone, code, expiresAt });

    // Enviar por WhatsApp
    const waTo = `${phone}@c.us`;
    console.log(`[sendOtp] Intentando encolar WhatsApp → to=${waTo} code=${code}`);
    try {
      const result = await enqueueWhatsappCommand({
        companyId: company._id,
        type: COMMAND_TYPES.SEND_MESSAGE,
        payload: {
          to: waTo,
          message:
            `🎾 *${company.name}* — Verificación de cuenta\n\n` +
            `Tu código es: *${code}*\n\n` +
            `Válido por ${OTP_TTL_MINUTES} minutos. No lo compartas con nadie.`,
        },
        requestedBy: null,
      });
      console.log(`[sendOtp] Comando encolado OK → commandId=${result?.command?._id} deduplicated=${result?.deduplicated} fallback=${result?.fallback || "none"}`);
    } catch (wpErr) {
      console.error(`[sendOtp] ERROR al encolar WhatsApp: ${wpErr?.message} | to=${waTo} | code=${code}`);
    }

    return res.json({
      success: true,
      data: { masked: maskPhone(phone) },
    });
  } catch {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// Función interna reutilizable para verificar OTP
const checkOtp = async (companyId, phone, code) => {
  const otp = await OtpVerification.findOne({
    companyId,
    phone: phoneMatchQuery(phone),
    used: false,
    expiresAt: { $gt: new Date() },
  });
  if (!otp) return { valid: false, reason: "Código inválido o expirado" };
  if (otp.code !== String(code)) return { valid: false, reason: "Código incorrecto" };
  return { valid: true, otp };
};

// POST /api/public/:slug/auth/register
const registerClient = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const { name, email, password, countryCode, localNumber, otp } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, error: "Nombre, email y contraseña son requeridos" });
    }
    if (!countryCode || !localNumber) {
      return res.status(400).json({ success: false, error: "Teléfono requerido" });
    }
    if (!otp) {
      return res.status(400).json({ success: false, error: "Código de verificación requerido" });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: "La contraseña debe tener al menos 6 caracteres" });
    }

    const phone = buildNormalizedPhone(countryCode, localNumber);
    if (!phone || phone.length < 7) {
      return res.status(400).json({ success: false, error: "Número de teléfono inválido" });
    }

    const otpCheck = await checkOtp(company._id, phone, otp);
    if (!otpCheck.valid) {
      return res.status(400).json({ success: false, error: otpCheck.reason });
    }

    const emailNorm = email.toLowerCase().trim();
    const [emailTaken, phoneTaken] = await Promise.all([
      ClientAccount.findOne({ companyId: company._id, email: emailNorm }),
      ClientAccount.findOne({ companyId: company._id, phone: phoneMatchQuery(phone) }),
    ]);

    if (emailTaken) {
      return res.status(409).json({ success: false, error: "Ya existe una cuenta con ese email" });
    }
    if (phoneTaken) {
      return res.status(409).json({ success: false, error: "Ya existe una cuenta con ese teléfono" });
    }

    await otpCheck.otp.updateOne({ used: true });

    const passwordHash = await bcrypt.hash(password, 10);
    const client = await ClientAccount.create({
      companyId: company._id,
      name: name.trim(),
      email: emailNorm,
      phone,
      passwordHash,
    });

    const linkedUser = await findOrCreateLinkedUser(company._id, phone, name.trim());
    client.linkedUserId = linkedUser._id;
    await client.save();

    return res.status(201).json({
      success: true,
      data: {
        token: signClientToken(client, company._id),
        client: clientPayload(client),
      },
    });
  } catch {
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

    return res.json({
      success: true,
      data: {
        token: signClientToken(client, company._id),
        client: clientPayload(client),
      },
    });
  } catch {
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

    const { idToken, countryCode, localNumber, otp } = req.body;
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

    const emailNorm = email.toLowerCase();

    let client = await ClientAccount.findOne({ companyId: company._id, email: emailNorm });
    const isNew = !client;

    if (isNew) {
      // Cuenta nueva — necesita teléfono verificado
      if (!countryCode || !localNumber) {
        return res.status(200).json({
          success: true,
          data: { needsPhone: true, name, email: emailNorm },
        });
      }

      const phone = buildNormalizedPhone(countryCode, localNumber);
      if (!phone || phone.length < 7) {
        return res.status(400).json({ success: false, error: "Número de teléfono inválido" });
      }

      if (!otp) {
        return res.status(400).json({ success: false, error: "Código de verificación requerido" });
      }

      const otpCheck = await checkOtp(company._id, phone, otp);
      if (!otpCheck.valid) {
        return res.status(400).json({ success: false, error: otpCheck.reason });
      }
      await otpCheck.otp.updateOne({ used: true });

      const phoneTaken = await ClientAccount.findOne({ companyId: company._id, phone: phoneMatchQuery(phone) });
      if (phoneTaken?.googleAuth) {
        return res.status(409).json({ success: false, error: "Ya existe una cuenta de Google con ese teléfono" });
      }

      // El nombre se preserva del perfil existente (User o ClientAccount por teléfono); fallback al de Google
      const existingUserForPhone = await User.findOne({ companyId: company._id, phoneNumber: phoneMatchQuery(phone) });
      const clientName = existingUserForPhone?.name || phoneTaken?.name || name || emailNorm.split("@")[0];

      // Si ya hay un ClientAccount con ese teléfono (email/contraseña), la cuenta Google
      // se crea sin teléfono para respetar la unicidad, pero se vincula al mismo User
      client = await ClientAccount.create({
        companyId: company._id,
        name: clientName,
        email: emailNorm,
        ...(phoneTaken ? {} : { phone }),
        passwordHash: await bcrypt.hash(Math.random().toString(36), 10),
        googleAuth: true,
      });

      const linkedUserId = phoneTaken?.linkedUserId
        ?? (await findOrCreateLinkedUser(company._id, phone, clientName, true, "google"))._id;
      client.linkedUserId = linkedUserId;
      await client.save();
    } else if (!client.phone && countryCode && localNumber && otp) {
      // Cuenta existente sin teléfono — verificar y actualizar
      const phone = buildNormalizedPhone(countryCode, localNumber);
      const otpCheck = await checkOtp(company._id, phone, otp);
      if (!otpCheck.valid) {
        return res.status(400).json({ success: false, error: otpCheck.reason });
      }
      const phoneTaken = await ClientAccount.findOne({ companyId: company._id, phone: phoneMatchQuery(phone), _id: { $ne: client._id } });
      if (phoneTaken?.googleAuth) {
        return res.status(409).json({ success: false, error: "Ya existe una cuenta de Google con ese teléfono" });
      }
      await otpCheck.otp.updateOne({ used: true });
      // Si hay otra cuenta con ese teléfono (email/contraseña), no tomar el número
      // pero sí vincular al mismo User
      if (!phoneTaken) client.phone = phone;
      const linkedUserId = phoneTaken?.linkedUserId
        ?? (await findOrCreateLinkedUser(company._id, phone, client.name, true))._id;
      client.linkedUserId = linkedUserId;
      await client.save();
    } else if (!client.phone && !client.linkedUserId) {
      // Cuenta sin teléfono ni vínculo aún — pedir teléfono
      return res.status(200).json({
        success: true,
        data: {
          needsPhone: true,
          name: client.name,
          email: client.email,
          token: signClientToken(client, company._id),
        },
      });
    }

    return res.status(isNew ? 201 : 200).json({
      success: true,
      data: {
        token: signClientToken(client, company._id),
        client: clientPayload(client),
        isNew,
        needsPhone: false,
      },
    });
  } catch {
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
    return res.json({ success: true, data: clientPayload(client) });
  } catch {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

// PUT /api/public/:slug/auth/me/phone  (requiere protectClient)
const updatePhone = async (req, res) => {
  try {
    const company = await resolveCompany(req.params.slug);
    if (!company) {
      return res.status(404).json({ success: false, error: "Club no encontrado" });
    }

    const { countryCode, localNumber, otp } = req.body;
    if (!countryCode || !localNumber || !otp) {
      return res.status(400).json({ success: false, error: "Teléfono y código de verificación requeridos" });
    }

    const phone = buildNormalizedPhone(countryCode, localNumber);
    if (!phone || phone.length < 7) {
      return res.status(400).json({ success: false, error: "Número de teléfono inválido" });
    }

    const otpCheck = await checkOtp(company._id, phone, otp);
    if (!otpCheck.valid) {
      return res.status(400).json({ success: false, error: otpCheck.reason });
    }

    const phoneTaken = await ClientAccount.findOne({
      companyId: company._id,
      phone: phoneMatchQuery(phone),
      _id: { $ne: req.clientUser.id },
    });
    if (phoneTaken) {
      return res.status(409).json({ success: false, error: "Ya existe una cuenta con ese teléfono" });
    }

    await otpCheck.otp.updateOne({ used: true });

    const client = await ClientAccount.findByIdAndUpdate(
      req.clientUser.id,
      { phone },
      { new: true },
    );
    if (!client) return res.status(404).json({ success: false, error: "Cuenta no encontrada" });

    return res.json({ success: true, data: clientPayload(client) });
  } catch {
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

    const closure = await ClubClosure.findOne({ companyId: company._id, date: searchDate });
    if (closure) {
      return res.status(409).json({ success: false, error: "El club está cerrado ese día" });
    }

    const [court, slot, client] = await Promise.all([
      Court.findOne({ _id: courtId, companyId: company._id, isActive: true }),
      TimeSlot.findOne({ _id: slotId, companyId: company._id, isActive: true }),
      ClientAccount.findById(req.clientUser.id),
    ]);

    if (!court) return res.status(404).json({ success: false, error: "Cancha no encontrada" });
    if (!slot) return res.status(404).json({ success: false, error: "Turno no encontrado" });
    if (!client) return res.status(404).json({ success: false, error: "Cuenta no encontrada" });

    const clientPhone = await resolveClientPhone(client);
    if (!clientPhone) {
      return res.status(400).json({ success: false, error: "Debés verificar tu teléfono antes de reservar" });
    }

    // Chequear si el cliente está suspendido en el sistema (por WhatsApp/admin)
    const suspendedUser = await User.findOne({
      companyId: company._id,
      phoneNumber: clientPhone,
      isSuspended: true,
    });
    if (suspendedUser) {
      return res.status(403).json({
        success: false,
        error: "Tu cuenta está suspendida. Comunicate con el club para más información.",
      });
    }

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

    const bookingFields = {
      clientName: client.name,
      clientPhone,
      status: "reservado",
      paymentStatus: "pendiente",
      finalPrice: slot.price || 0,
      isFixed: false,
    };

    let booking;
    try {
      booking = await Booking.create({
        companyId: company._id,
        court: court._id,
        date: searchDate,
        timeSlot: slot._id,
        ...bookingFields,
      });
    } catch (createErr) {
      if (createErr.code !== 11000) throw createErr;

      // El índice único incluye el doc cancelado — reusar ese documento
      const cancelled = await Booking.findOne({
        companyId: company._id,
        court: court._id,
        date: searchDate,
        timeSlot: slot._id,
        status: "cancelado",
      });
      if (!cancelled) {
        return res.status(409).json({ success: false, error: "Ese turno ya está reservado" });
      }
      cancelled.set(bookingFields);
      booking = await cancelled.save();
    }

    const populated = await Booking.findById(booking._id)
      .populate("court")
      .populate("timeSlot");

    return res.status(201).json({
      success: true,
      data: { ...populated.toObject(), date: toIsoDateOnly(populated.date) },
    });
  } catch (err) {
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

    const clientPhone = await resolveClientPhone(client);
    if (!clientPhone) {
      return res.json({ success: true, data: [] });
    }

    const todayStart = todayUtcMidnightInTimezone(TIMEZONE);
    const historyFrom = new Date(todayStart);
    historyFrom.setUTCDate(historyFrom.getUTCDate() - 60); // últimos 60 días

    const [upcoming, history] = await Promise.all([
      Booking.find({
        companyId: company._id,
        clientPhone: phoneMatchQuery(clientPhone),
        status: { $nin: ["cancelado"] },
        date: { $gte: todayStart },
      }).populate("court").populate("timeSlot").sort({ date: 1 }),

      Booking.find({
        companyId: company._id,
        clientPhone: phoneMatchQuery(clientPhone),
        date: { $gte: historyFrom, $lt: todayStart },
      }).populate("court").populate("timeSlot").sort({ date: -1 }).limit(30),
    ]);

    const fmt = (b) => ({ ...b.toObject(), date: toIsoDateOnly(b.date) });

    return res.json({
      success: true,
      data: {
        upcoming: upcoming.map(fmt),
        history: history.map(fmt),
      },
    });
  } catch {
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

    const clientPhone = await resolveClientPhone(client);
    const booking = await Booking.findOne({
      _id: req.params.id,
      companyId: company._id,
      clientPhone: phoneMatchQuery(clientPhone),
    });

    if (!booking) {
      return res.status(404).json({ success: false, error: "Reserva no encontrada" });
    }
    if (booking.status === "cancelado") {
      return res.status(409).json({ success: false, error: "La reserva ya está cancelada" });
    }

    const slot = await TimeSlot.findById(booking.timeSlot).lean();
    const cancellationLockHours = await getCancellationLockHours(company._id);
    if (cancellationLockHours > 0 && slot) {
      const dateStr = toIsoDateOnly(booking.date);
      const minutesUntilStart = getMinutesUntilSlotStart(dateStr, slot.startTime);
      if (minutesUntilStart < cancellationLockHours * 60) {
        return res.status(409).json({
          success: false,
          error: `No podés cancelar con menos de ${cancellationLockHours} hora${cancellationLockHours !== 1 ? "s" : ""} de anticipación`,
          code: "CANCELLATION_BLOCKED_WINDOW",
          data: { cancellationLockHours },
        });
      }
    }

    booking.status = "cancelado";
    await booking.save();

    // Notificar al admin por WhatsApp
    const [adminPhone, courtDoc] = await Promise.all([
      getCancellationContactPhone(company._id),
      Court.findById(booking.court).lean(),
    ]);

    if (adminPhone) {
      const dateStr = formatBookingDateShort(booking.date);
      const timeStr = slot?.startTime || "";
      const courtName = courtDoc?.name || "";
      const message =
        `❌ *Turno cancelado desde el portal*\n\n` +
        `👤 Cliente: ${booking.clientName}\n` +
        `📅 Fecha: ${dateStr}\n` +
        `🕐 Hora: ${timeStr}\n` +
        `🎾 Cancha: ${courtName}`;

      enqueueWhatsappCommand({
        companyId: company._id,
        type: COMMAND_TYPES.SEND_MESSAGE,
        payload: { to: `${adminPhone}@c.us`, message },
        requestedBy: null,
      }).catch((err) => {
        console.error("[cancelMyBooking] Error enviando WhatsApp al admin:", err?.message);
      });
    }

    // Notificar al grupo de cancelaciones si está configurado
    enqueueWhatsappCommand({
      companyId: company._id,
      type: COMMAND_TYPES.NOTIFY_CANCELLATION_GROUP,
      payload: {
        booking: { date: booking.date, timeSlot: { startTime: slot?.startTime || "" } },
        time: slot?.startTime || "",
        cancelledBy: "cliente (portal)",
      },
    }).catch((err) => {
      console.error("[cancelMyBooking] Error notificando grupo:", err?.message);
    });

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ success: false, error: "Error interno" });
  }
};

module.exports = {
  getClubInfo,
  getAvailability,
  sendOtp,
  registerClient,
  loginClient,
  googleAuth,
  getMe,
  updatePhone,
  createClientBooking,
  getMyBookings,
  cancelMyBooking,
};

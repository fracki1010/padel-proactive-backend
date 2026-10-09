const mongoose = require("mongoose");
const User = require("../models/user.model");
const ClientAccount = require("../models/clientAccount.model");
const Booking = require("../models/booking.model");
const {
  materializeFixedBookingsInRange,
} = require("../services/fixedTurnsMaterialization.service");
const {
  getTrustedClientConfirmationCount,
  isDepositExempt,
  addDepositExemptPhone,
  removeDepositExemptPhone,
} = require("../services/appConfig.service");
const {
  getWhatsappIdByPhone,
} = require("../utils/getWhatsappIdByPhone");
const {
  buildVerifiedUserIdSet,
  isUserVerified,
  shouldBlockVerifiedPhoneEdit,
  canonicalPhoneKey,
} = require("../services/clientVerification.service");
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

const enrichUserWithReliability = (
  user,
  trustedClientConfirmationCount = 3,
  extra = {},
) => {
  const source = typeof user?.toObject === "function" ? user.toObject() : user;
  const attendanceConfirmedCount = Number(source?.attendanceConfirmedCount || 0);
  const trustedThreshold = Number(trustedClientConfirmationCount || 3);
  const confirmationsToBeTrusted = Math.max(
    0,
    trustedThreshold - attendanceConfirmedCount,
  );

  return {
    ...source,
    ...extra,
    attendanceConfirmedCount,
    trustedClientConfirmationCount: trustedThreshold,
    confirmationsToBeTrusted,
    isTrustedClient: attendanceConfirmedCount >= trustedThreshold,
  };
};

const getUsers = async (req, res, deps = {}) => {
  const {
    UserModel = User,
    ClientAccountModel = ClientAccount,
    getTrustedConfirmationCount = getTrustedClientConfirmationCount,
  } = deps;
  try {
    const companyId = resolveCompanyId(req);
    const trustedClientConfirmationCount =
      await getTrustedConfirmationCount(companyId);

    const [users, unlinkedAccounts] = await Promise.all([
      UserModel.find(companyScope(req, companyId)).sort({ name: 1 }),
      ClientAccountModel.find({
        ...companyScope(req, companyId),
        linkedUserId: null,
      }),
    ]);

    const accountsAsUsers = unlinkedAccounts.map((acc) => ({
      _id: acc._id,
      companyId: acc.companyId,
      name: acc.name,
      phoneNumber: acc.phone || "",
      email: acc.email,
      fixedTurns: [],
      penalties: 0,
      isSuspended: false,
      attendanceConfirmedCount: 0,
      isClientAccount: true,
    }));

    const combined = [...users, ...accountsAsUsers].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    // Single batched query: which of these Users have a linked ClientAccount.
    const userIds = users.map((user) => user._id);
    const linkedAccounts = userIds.length
      ? await ClientAccountModel.find({
          ...companyScope(req, companyId),
          linkedUserId: { $in: userIds },
        }).select("linkedUserId")
      : [];
    const verifiedUserIds = buildVerifiedUserIdSet(linkedAccounts);

    res.status(200).json({
      success: true,
      count: combined.length,
      data: combined.map((u) =>
        enrichUserWithReliability(u, trustedClientConfirmationCount, {
          isVerified: isUserVerified(u, verifiedUserIds),
        }),
      ),
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

const getUserById = async (req, res, deps = {}) => {
  const {
    UserModel = User,
    ClientAccountModel = ClientAccount,
    getTrustedConfirmationCount = getTrustedClientConfirmationCount,
    isDepositExemptForCompany = isDepositExempt,
  } = deps;
  try {
    const companyId = resolveCompanyId(req);
    const trustedClientConfirmationCount =
      await getTrustedConfirmationCount(companyId);

    const user = await UserModel.findOne({
      _id: req.params.id,
      ...companyScope(req, companyId),
    }).populate(["fixedTurns.court", "fixedTurns.timeSlot"]);

    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "Usuario no encontrado" });
    }

    const linkedAccount = await ClientAccountModel.findOne({
      linkedUserId: user._id,
    }).select("linkedUserId");

    // Exemption is computed from the user's own company AppConfig (no extra
    // hot-path query for bookings; this is an admin detail read).
    const depositExempt = await isDepositExemptForCompany(
      user.companyId || companyId,
      user.phoneNumber,
    );

    return res.status(200).json({
      success: true,
      data: enrichUserWithReliability(user, trustedClientConfirmationCount, {
        isVerified: Boolean(linkedAccount),
        depositExempt: Boolean(depositExempt),
      }),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const createUser = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const phoneNumber = (req.body.phoneNumber || "").trim();

    // Prevent duplicate clients: check if a user with this phone already exists
    if (phoneNumber) {
      const existingUser = await User.findOne({
        ...companyScope(req, companyId),
        phoneNumber,
      });

      if (existingUser) {
        return res.status(400).json({
          success: false,
          error: "Ya existe un cliente con este número de teléfono",
        });
      }
    }

    const resolvedWhatsappId =
      req.body.whatsappId ||
      (await getWhatsappIdByPhone(phoneNumber, companyId));

    const user = await User.create({
      ...req.body,
      name: (req.body.name || "").trim(),
      phoneNumber,
      whatsappId: resolvedWhatsappId,
      ...companyScope(req, companyId),
    });

    if (Array.isArray(user.fixedTurns) && user.fixedTurns.length > 0) {
      const targetCompanyId =
        user.companyId !== undefined ? user.companyId : companyId;
      await materializeFixedBookingsInRange({
        companyId: targetCompanyId,
        userId: user._id,
      });
    }

    res.status(201).json({ success: true, data: user });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

const updateUser = async (req, res, deps = {}) => {
  const {
    UserModel = User,
    ClientAccountModel = ClientAccount,
  } = deps;
  try {
    const companyId = resolveCompanyId(req);

    const currentUser = await UserModel.findOne({
      _id: req.params.id,
      ...companyScope(req, companyId),
    });
    if (!currentUser) {
      return res
        .status(404)
        .json({ success: false, error: "Usuario no encontrado" });
    }

    // A verified client (linked ClientAccount) cannot change its phone number.
    const hasPhoneField = Object.prototype.hasOwnProperty.call(
      req.body,
      "phoneNumber",
    );
    if (hasPhoneField) {
      const linkedAccount = await ClientAccountModel.findOne({
        linkedUserId: currentUser._id,
      }).select("linkedUserId");
      const isVerified = Boolean(linkedAccount);
      if (
        shouldBlockVerifiedPhoneEdit({
          isVerified,
          currentPhone: currentUser.phoneNumber,
          nextPhone: req.body.phoneNumber,
        })
      ) {
        return res.status(400).json({
          success: false,
          error: "El teléfono de un socio verificado no se puede modificar",
        });
      }
    }

    const user = await UserModel.findOneAndUpdate(
      { _id: req.params.id, ...companyScope(req, companyId) },
      req.body,
      { returnDocument: "after", runValidators: true },
    );
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "Usuario no encontrado" });
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "fixedTurns")) {
      const targetCompanyId =
        user.companyId !== undefined ? user.companyId : companyId;
      await materializeFixedBookingsInRange({
        companyId: targetCompanyId,
        userId: user._id,
      });
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

    if (user) {
      // Eliminar también el ClientAccount vinculado si existe
      await ClientAccount.deleteOne({ linkedUserId: user._id });
      // Eliminar solo los turnos fijos futuros materializados del usuario
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      await Booking.deleteMany({
        companyId: user.companyId,
        clientWhatsappId: user.whatsappId,
        isFixed: true,
        date: { $gte: today },
      });
      return res.status(200).json({ success: true, data: {} });
    }

    // Si no era un User, intentar eliminar un ClientAccount desvinculado (socios de Google sin WhatsApp)
    const account = await ClientAccount.findOneAndDelete({
      _id: req.params.id,
      ...companyScope(req, companyId),
    });

    if (!account) {
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

const adjustAttendanceConfirmedCount = async (req, res) => {
  try {
    const companyId = resolveCompanyId(req);
    const rawDelta = Number(req.body?.delta);

    if (!Number.isInteger(rawDelta) || rawDelta === 0) {
      return res.status(400).json({
        success: false,
        error: "delta debe ser un entero distinto de 0.",
      });
    }

    if (rawDelta < -50 || rawDelta > 50) {
      return res.status(400).json({
        success: false,
        error: "delta fuera de rango. Permitido: -50 a 50.",
      });
    }

    const trustedClientConfirmationCount =
      await getTrustedClientConfirmationCount(companyId);

    const user = await User.findOne({
      _id: req.params.id,
      ...companyScope(req, companyId),
    });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "Usuario no encontrado" });
    }

    const currentCount = Number(user.attendanceConfirmedCount || 0);
    user.attendanceConfirmedCount = Math.max(0, currentCount + rawDelta);
    await user.save();

    return res.status(200).json({
      success: true,
      data: enrichUserWithReliability(user, trustedClientConfirmationCount),
      meta: {
        deltaApplied: rawDelta,
      },
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
};

// PUT /api/users/:id/deposit-exempt  { enabled: boolean }
// Admin-only (enforced at the route), company-scoped. Writes the canonical
// phone key onto the target user's company AppConfig; idempotent by design.
const setDepositExemption = async (req, res, deps = {}) => {
  const {
    UserModel = User,
    addExemptPhone = addDepositExemptPhone,
    removeExemptPhone = removeDepositExemptPhone,
  } = deps;
  try {
    const companyId = resolveCompanyId(req);
    const enabled = req.body?.enabled;

    if (typeof enabled !== "boolean") {
      return res
        .status(400)
        .json({ success: false, error: "enabled must be a boolean." });
    }

    if (!mongoose.isValidObjectId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, error: "Usuario inválido" });
    }

    const user = await UserModel.findOne({
      _id: req.params.id,
      ...companyScope(req, companyId),
    });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "Usuario no encontrado" });
    }

    if (!canonicalPhoneKey(user.phoneNumber)) {
      return res.status(400).json({
        success: false,
        error: "El usuario no tiene un teléfono válido para eximir.",
      });
    }

    // Always scope the write to the target user's own company so a super_admin
    // can never mis-scope the exemption onto another tenant.
    const targetCompanyId = user.companyId || companyId;
    if (enabled) {
      await addExemptPhone(targetCompanyId, user.phoneNumber);
    } else {
      await removeExemptPhone(targetCompanyId, user.phoneNumber);
    }

    return res.status(200).json({
      success: true,
      data: { depositExempt: enabled },
    });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({ success: false, error: error.message });
  }
};

module.exports = {
  getUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getUserHistory,
  clearPenalties,
  adjustAttendanceConfirmedCount,
  setDepositExemption,
};

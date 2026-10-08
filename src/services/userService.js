// src/services/userService.js
const User = require("../models/user.model");
const { getNumberByUser } = require("../utils/getNumberByUser");
const { isLidIdentifier } = require("../whatsapp/domain/clientIdentity");

// Buscar usuario por su ID de WhatsApp
const getUserByWhatsappId = async (whatsappId, options = {}) => {
  try {
    const companyId = options.companyId || null;
    return await User.findOne({ whatsappId, companyId });
  } catch (error) {
    console.error("Error buscando usuario:", error);
    return null;
  }
};

// Crear o Actualizar usuario
// El nombre solo se guarda la primera vez; una vez registrado no puede cambiarse por WhatsApp.
const saveOrUpdateUser = async (whatsappId, name, options = {}) => {
  try {
    const companyId = options.companyId || null;
    const cleanPhone = await getNumberByUser(whatsappId, companyId);

    // A Linked-Device ID (@lid) is not a phone number. A LID-derived phone must
    // never be persisted: it would split the person's identity (unique index on
    // companyId + phoneNumber) and could merge a wrong user.
    const isLid = isLidIdentifier(whatsappId);
    const lidDigits = String(whatsappId || "").split("@")[0].replace(/\D/g, "");
    const phoneIsLidDerived = isLid && (!cleanPhone || cleanPhone === lidDigits);
    const usablePhone = phoneIsLidDerived ? "" : cleanPhone;

    let existingUser = await User.findOne({ whatsappId, companyId }).lean();

    // Fallback: if not found by whatsappId, look up by phoneNumber to avoid
    // duplicates. Never use a LID-derived phone for this lookup.
    if (!existingUser && usablePhone) {
      existingUser = await User.findOne({ companyId, phoneNumber: usablePhone }).lean();

      // If found by phone but has a different whatsappId, update it so future lookups match
      if (existingUser && existingUser.whatsappId !== whatsappId) {
        existingUser = await User.findOneAndUpdate(
          { _id: existingUser._id },
          { whatsappId },
          { new: true },
        ).lean();
      }
    }

    // `phoneNumber` is required (and covered by a partial unique index). If the
    // identity has no usable phone and no existing user, do NOT upsert: a phone
    // cannot be fabricated, and `findOneAndUpdate` would otherwise insert an
    // invalid, phone-less User because validators are not run.
    if (!existingUser && !usablePhone) {
      return null;
    }

    const resolvedName = existingUser?.name ? existingUser.name : name;

    const setFields = {
      companyId,
      whatsappId,
      name: resolvedName,
      lastInteraction: new Date(),
    };
    // Keep the existing phone when the incoming identity has no usable one.
    if (usablePhone) setFields.phoneNumber = usablePhone;

    const user = await User.findOneAndUpdate(
      { whatsappId, companyId },
      {
        $set: setFields,
        $setOnInsert: { accountOrigin: "whatsapp" },
      },
      { upsert: true, returnDocument: "after" },
    );
    return user;
  } catch (error) {
    console.error("Error guardando usuario:", error);
  }
};

module.exports = { getUserByWhatsappId, saveOrUpdateUser };

// src/services/userService.js
const User = require("../models/user.model");
const { getNumberByUser } = require("../utils/getNumberByUser");

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

    let existingUser = await User.findOne({ whatsappId, companyId }).lean();

    // Fallback: if not found by whatsappId, look up by phoneNumber to avoid duplicates
    if (!existingUser && cleanPhone) {
      existingUser = await User.findOne({ companyId, phoneNumber: cleanPhone }).lean();

      // If found by phone but has a different whatsappId, update it so future lookups match
      if (existingUser && existingUser.whatsappId !== whatsappId) {
        existingUser = await User.findOneAndUpdate(
          { _id: existingUser._id },
          { whatsappId },
          { new: true },
        ).lean();
      }
    }

    const resolvedName = existingUser?.name ? existingUser.name : name;

    const user = await User.findOneAndUpdate(
      { whatsappId, companyId },
      {
        $set: {
          companyId,
          whatsappId,
          name: resolvedName,
          phoneNumber: cleanPhone,
          lastInteraction: new Date(),
        },
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

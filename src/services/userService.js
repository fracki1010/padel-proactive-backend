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
// Si cambia el nombre, lo actualizamos.
const saveOrUpdateUser = async (whatsappId, name, options = {}) => {
  try {
    const companyId = options.companyId || null;
    const cleanPhone = await getNumberByUser(whatsappId, companyId);

    const user = await User.findOneAndUpdate(
      { whatsappId, companyId }, // Filtro
      {
        companyId,
        whatsappId,
        name,
        phoneNumber: cleanPhone,
        lastInteraction: new Date(),
      },
      { upsert: true, returnDocument: "after" }, // Upsert: Si no existe, crea. Si existe, actualiza.
    );
    return user;
  } catch (error) {
    console.error("Error guardando usuario:", error);
  }
};

module.exports = { getUserByWhatsappId, saveOrUpdateUser };

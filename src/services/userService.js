// src/services/userService.js
const User = require("../models/user.model");
const { getNumberByUser } = require("../utils/getNumberByUser");

// Buscar usuario por su ID de WhatsApp
const getUserByWhatsappId = async (whatsappId) => {
  try {
    return await User.findOne({ whatsappId });
  } catch (error) {
    console.error("Error buscando usuario:", error);
    return null;
  }
};

// Crear o Actualizar usuario
// Si cambia el nombre, lo actualizamos.
const saveOrUpdateUser = async (whatsappId, name) => {
  try {
    const cleanPhone = await getNumberByUser(whatsappId);

    const user = await User.findOneAndUpdate(
      { whatsappId }, // Filtro
      {
        whatsappId,
        name,
        phoneNumber: cleanPhone,
        lastInteraction: new Date(),
      },
      { upsert: true, new: true }, // Upsert: Si no existe, crea. Si existe, actualiza.
    );
    return user;
  } catch (error) {
    console.error("Error guardando usuario:", error);
  }
};

module.exports = { getUserByWhatsappId, saveOrUpdateUser };

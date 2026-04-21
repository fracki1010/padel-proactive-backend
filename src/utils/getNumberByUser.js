const {
  normalizeCanonicalClientPhone,
} = require("./identityNormalization");
const client = require("whatsapp-web.js");

async function getNumberByUser(whatsappId) {
  const chatId = String(whatsappId || "").trim();
  if (!chatId) return "";

  // En arquitectura desacoplada no hay cliente WA en backend;
  // usamos el chatId (ej: 54911xxxxxxx@c.us) como fuente canónica.
  if (!client) {
    return normalizeCanonicalClientPhone(chatId);
  }

  const contact = await client.getContactById(chatId);
  const fromContact = normalizeCanonicalClientPhone(contact?.number || "");
  if (fromContact) return fromContact;

  return normalizeCanonicalClientPhone(chatId);
}

module.exports = { getNumberByUser };

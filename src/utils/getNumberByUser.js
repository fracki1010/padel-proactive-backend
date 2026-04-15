const extractDigits = (value = "") => String(value || "").replace(/\D/g, "");

async function getNumberByUser(whatsappId, client) {
  const chatId = String(whatsappId || "").trim();
  if (!chatId) return "";

  // En arquitectura desacoplada no hay cliente WA en backend;
  // usamos el chatId (ej: 54911xxxxxxx@c.us) como fuente canónica.
  if (!client) {
    const localPart = chatId.split("@")[0];
    return extractDigits(localPart);
  }

  const contact = await client.getContactById(chatId);
  const fromContact = extractDigits(contact?.number || "");
  if (fromContact) return fromContact;

  const localPart = chatId.split("@")[0];
  return extractDigits(localPart);
}

module.exports = { getNumberByUser };

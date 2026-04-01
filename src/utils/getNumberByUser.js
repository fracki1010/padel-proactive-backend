async function getNumberByUser(whatsappId, client) {
  if (!client) {
    throw new Error("Cliente de WhatsApp no disponible para obtener número.");
  }
  const number = await client.getContactById(whatsappId);
  return number.number.replace("+", "");
}

module.exports = { getNumberByUser };

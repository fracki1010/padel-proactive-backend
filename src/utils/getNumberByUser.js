const client = require("../config/whatsappClient");

async function getNumberByUser(whatsappId) {
  const number = await client.getContactById(whatsappId);
  return number.number.replace("+", "");
}

module.exports = { getNumberByUser };

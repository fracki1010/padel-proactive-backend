const axios = require("axios");
const { normalizeCanonicalClientPhone } = require("./identityNormalization");

const WORKER_URL = process.env.WHATSAPP_WORKER_URL || "http://localhost:3010";

async function getNumberByUser(whatsappId) {
  const chatId = String(whatsappId || "").trim();
  if (!chatId) return "";

  try {
    const { data } = await axios.get(
      `${WORKER_URL}/get-number/${encodeURIComponent(chatId)}`,
      { timeout: 3000 },
    );
    console.log(data);
    
    if (data?.phoneNumber) return data.phoneNumber;
  } catch {
    // worker no disponible, fallback a normalización local
  }

  return normalizeCanonicalClientPhone(chatId);
}

module.exports = { getNumberByUser };

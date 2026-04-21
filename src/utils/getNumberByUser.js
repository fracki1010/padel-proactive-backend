const axios = require("axios");
const { normalizeCanonicalClientPhone } = require("./identityNormalization");

const WORKER_URL = process.env.WHATSAPP_WORKER_URL || "http://localhost:3010";

async function getNumberByUser(whatsappId, companyId = null) {
  const chatId = String(whatsappId || "").trim();
  if (!chatId) return "";

  try {
    const params = companyId ? { companyId } : {};
    const url = `${WORKER_URL}/get-number/${encodeURIComponent(chatId)}`;
    console.log(`[getNumberByUser] → worker: ${url}`, { companyId });
    const { data } = await axios.get(url, { params, timeout: 3000 });
    console.log(`[getNumberByUser] ← worker respondió:`, data);
    if (data?.phoneNumber) return data.phoneNumber;
  } catch (error) {
    console.warn(`[getNumberByUser] worker no disponible, usando fallback. Error: ${error.message}`);
  }

  const fallback = normalizeCanonicalClientPhone(chatId);
  console.log(`[getNumberByUser] fallback local:`, fallback);
  return fallback;
}

module.exports = { getNumberByUser };

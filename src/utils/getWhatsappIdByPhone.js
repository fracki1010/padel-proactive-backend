const axios = require("axios");

const WORKER_URL = process.env.WHATSAPP_WORKER_URL || "http://localhost:3010";

async function getWhatsappIdByPhone(phone, companyId = null) {
  if (!phone) return null;
  try {
    const params = companyId ? { companyId } : {};
    const url = `${WORKER_URL}/get-id-by-number/${encodeURIComponent(phone)}`;
    const { data } = await axios.get(url, { params, timeout: 3000 });
    return data?.whatsappId || null;
  } catch (err) {
    console.warn(`[getWhatsappIdByPhone] worker no disponible: ${err.message}`);
    return null;
  }
}

module.exports = { getWhatsappIdByPhone };

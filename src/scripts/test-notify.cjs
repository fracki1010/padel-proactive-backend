// test-notify.cjs
require("dotenv").config();
const axios = require("axios");

// Configuración
const API_URL = "http://localhost:3000/api/notifications/send-test";
// Necesitas un token válido de admin — provéelo vía env ADMIN_TOKEN
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

async function notify() {
  try {
    const response = await axios.post(
      API_URL,
      {
        title: "Notificación desde Terminal",
        message: "Este mensaje fue enviado ejecutando el script de consola.",
        type: "system",
      },
      {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );

    console.log("✅ Éxito:", response.data.message);
  } catch (error) {
    console.error("❌ Error:", error.response?.data || error.message);
  }
}

notify();

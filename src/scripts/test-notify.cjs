// test-notify.cjs
require("dotenv").config();
const axios = require("axios");

// Configuración
const API_URL = "http://localhost:3000/api/notifications/send-test";
const ADMIN_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5YjZjNWVkOWY5NDI5MDExYjU2OGU3ZiIsInVzZXJuYW1lIjoiYWRtaW4iLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE3NzM1ODY4MjYsImV4cCI6MTc3MzY3MzIyNn0.JmlLvtQTFUE4XCvaToxiPYb6ONyYa96ZRPbbacezwDs"; // Necesitas un token válido de admin

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

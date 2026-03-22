require("dotenv").config();
const qrcode = require("qrcode-terminal");
const connectDB = require("./src/config/database");
const app = require("./src/app");
const { handleIncomingMessage } = require("./src/handlers/messageHandler");
const client = require("./src/config/whatsappClient");
const {
  setQr,
  setLoading,
  setAuthenticated,
  setAuthFailure,
  setReady,
} = require("./src/state/whatsapp.state");

const PORT = process.env.PORT || 3000;

// 1. Conexión a Base de Datos y Servidor Express
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ Error al conectar MongoDB:", err);
  });

// --- EVENTOS DE MONITOREO ---

client.on("qr", (qr) => {
  console.log("✨ Nuevo código QR generado. Escanealo por favor:");
  qrcode.generate(qr, { small: true });
  setQr(qr);
});

client.on("loading_screen", (percent, message) => {
  console.log(`⏳ Cargando WhatsApp: ${percent}% - ${message}`);
  setLoading(percent, message);
});

client.on("authenticated", () => {
  console.log("✅ ¡Autenticación exitosa!");
  setAuthenticated();
});

client.on("auth_failure", (msg) => {
  console.error("❌ Fallo de autenticación:", msg);
  setAuthFailure(msg);
});

client.on("ready", () => {
  console.log("--------------------------------------------");
  console.log("🌟 ¡BOT DE WHATSAPP LISTO Y CONECTADO! 🌟");
  console.log("--------------------------------------------");
  setReady();
});

// --- EVENTO DE MENSAJE ---
client.on("message", async (message) => {
  // Validaciones básicas
  if (message.from === "status@broadcast" || message.from.includes("@g.us"))
    return;
  if (!message.body) return;

  const chatId = message.from;
  console.log(`📩 Mensaje de ${chatId}: ${message.body}`);

  try {
    const chat = await message.getChat();

    // Simular que escribe da una sensación más humana
    await chat.sendStateTyping();

    // 1. Obtenemos la respuesta cruda del handler
    let responseRaw = await handleIncomingMessage(chatId, message.body);
    let messageToSend = responseRaw;

    // 2. Lógica de limpieza: Detectar si es JSON u Objeto
    if (typeof responseRaw === "object" && responseRaw.message) {
      // Caso A: El handler devolvió un objeto Javascript { message: "..." }
      messageToSend = responseRaw.message;
    } else if (
      typeof responseRaw === "string" &&
      responseRaw.trim().startsWith("{")
    ) {
      // Caso B: El handler devolvió un STRING en formato JSON '{"message": "..."}'
      try {
        const parsed = JSON.parse(responseRaw);
        if (parsed.message) {
          messageToSend = parsed.message;
        }
      } catch (e) {
        console.log("El string parecía JSON pero no lo era, se envía normal.");
      }
    }

    // 3. Responder solo con el texto limpio
    await message.reply(messageToSend);
  } catch (error) {
    console.error("Error procesando mensaje:", error);
  }
});

// 3. Inicialización con manejo de errores
console.log("🚀 Iniciando el proceso de WhatsApp...");
client.initialize().catch((err) => {
  console.error("❌ Error crítico en initialize():", err);
});

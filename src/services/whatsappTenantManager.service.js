const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const {
  buildCompanyKey,
  getWhatsappState,
  setQr,
  setLoading,
  setAuthenticated,
  setAuthFailure,
  setReady,
} = require("../state/whatsapp.state");

const clients = new Map();

const WA_REMOTE_HTML =
  "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html";

const buildClientId = (companyId = null) => `tenant-${buildCompanyKey(companyId)}`;

const createClient = (companyId = null) => {
  const key = buildCompanyKey(companyId);
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: buildClientId(companyId) }),
    executablePath: "/usr/bin/chromium",
    webVersionCache: {
      type: "remote",
      remotePath: WA_REMOTE_HTML,
    },
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
      ],
    },
  });

  client.isReady = false;

  client.on("qr", (qr) => {
    console.log(`✨ [${key}] Nuevo código QR generado.`);
    qrcode.generate(qr, { small: true });
    setQr(companyId, qr);
  });

  client.on("loading_screen", (percent, message) => {
    console.log(`⏳ [${key}] Cargando WhatsApp: ${percent}% - ${message}`);
    setLoading(companyId, percent, message);
  });

  client.on("authenticated", () => {
    console.log(`✅ [${key}] ¡Autenticación exitosa!`);
    setAuthenticated(companyId);
  });

  client.on("auth_failure", (msg) => {
    console.error(`❌ [${key}] Fallo de autenticación:`, msg);
    setAuthFailure(companyId, msg);
  });

  client.on("ready", () => {
    client.isReady = true;
    console.log(`🌟 [${key}] BOT DE WHATSAPP LISTO Y CONECTADO`);
    setReady(companyId);
  });

  client.on("disconnected", () => {
    client.isReady = false;
  });

  client.on("message", async (message) => {
    if (!getWhatsappState(companyId).enabled) return;
    if (message.from === "status@broadcast" || message.from.includes("@g.us")) return;
    if (!message.body) return;

    try {
      const { handleIncomingMessage } = require("../handlers/messageHandler");
      const chat = await message.getChat();
      await chat.sendStateTyping();

      const responseRaw = await handleIncomingMessage(message.from, message.body, {
        companyId,
        client,
      });

      let messageToSend = responseRaw;
      if (typeof responseRaw === "object" && responseRaw.message) {
        messageToSend = responseRaw.message;
      } else if (
        typeof responseRaw === "string" &&
        responseRaw.trim().startsWith("{")
      ) {
        try {
          const parsed = JSON.parse(responseRaw);
          if (parsed.message) messageToSend = parsed.message;
        } catch (_error) {
          // noop
        }
      }

      await message.reply(messageToSend);
    } catch (error) {
      console.error(`[${key}] Error procesando mensaje:`, error);
    }
  });

  return client;
};

const ensureEntry = (companyId = null) => {
  const key = buildCompanyKey(companyId);
  if (!clients.has(key)) {
    clients.set(key, {
      companyId,
      client: createClient(companyId),
      isStarting: false,
      stopRequestedDuringStart: false,
    });
  }
  return clients.get(key);
};

const startClient = async (companyId = null) => {
  const entry = ensureEntry(companyId);
  const { client } = entry;

  if (client.isReady || entry.isStarting) return client;

  entry.stopRequestedDuringStart = false;
  entry.isStarting = true;

  try {
    await client.initialize();
  } finally {
    entry.isStarting = false;
    if (entry.stopRequestedDuringStart) {
      entry.stopRequestedDuringStart = false;
      await stopClient(companyId);
    }
  }

  return client;
};

const stopClient = async (companyId = null) => {
  const entry = ensureEntry(companyId);
  if (entry.isStarting) {
    entry.stopRequestedDuringStart = true;
    return;
  }

  try {
    await entry.client.destroy();
  } catch (_error) {
    // Ignorar cuando el cliente todavía no estaba levantado.
  } finally {
    entry.client.isReady = false;
  }
};

const getClient = (companyId = null) => ensureEntry(companyId).client;

module.exports = {
  startClient,
  stopClient,
  getClient,
};

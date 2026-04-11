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
  setDisconnected,
  setStartAttempt,
  setLastError,
  incrementReconnectAttempts,
  resetReconnectAttempts,
} = require("../state/whatsapp.state");

const clients = new Map();

const WA_REMOTE_HTML =
  process.env.WA_REMOTE_HTML ||
  "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html";

const buildClientId = (companyId = null) => `tenant-${buildCompanyKey(companyId)}`;

const createClient = (companyId = null) => {
  const key = buildCompanyKey(companyId);
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: buildClientId(companyId) }),
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      process.env.CHROMIUM_PATH ||
      "/usr/bin/chromium",
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
    resetReconnectAttempts(companyId);
    setReady(companyId);
  });

  client.on("disconnected", (reason) => {
    client.isReady = false;
    console.warn(`⚠️ [${key}] Cliente desconectado: ${reason || "desconocido"}`);
    setDisconnected(companyId, reason);
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

const createEntry = (companyId = null) => ({
  companyId,
  client: createClient(companyId),
  isStarting: false,
  stopRequestedDuringStart: false,
  startPromise: null,
  hasInitialized: false,
});

const ensureEntry = (companyId = null) => {
  const key = buildCompanyKey(companyId);
  if (!clients.has(key)) {
    clients.set(key, createEntry(companyId));
  }
  return clients.get(key);
};

const startClient = async (companyId = null) => {
  const key = buildCompanyKey(companyId);
  const entry = ensureEntry(companyId);
  const { client } = entry;

  if (client.isReady) return client;
  if (entry.isStarting && entry.startPromise) return entry.startPromise;

  entry.stopRequestedDuringStart = false;
  entry.isStarting = true;
  setStartAttempt(companyId, "Inicializando cliente de WhatsApp...");
  console.log(`[WhatsApp][${key}] startClient initialize requested.`);

  entry.startPromise = (async () => {
    try {
      await client.initialize();
      entry.hasInitialized = true;
      console.log(`[WhatsApp][${key}] startClient initialize OK.`);
      return client;
    } catch (error) {
      const message = error?.message || String(error);
      setLastError(companyId, message);
      console.error(`[WhatsApp][${key}] startClient initialize ERROR:`, message);
      throw error;
    } finally {
      entry.isStarting = false;
      entry.startPromise = null;
      if (entry.stopRequestedDuringStart) {
        entry.stopRequestedDuringStart = false;
        await stopClient(companyId);
      }
    }
  })();

  return entry.startPromise;
};

const stopClient = async (companyId = null) => {
  const key = buildCompanyKey(companyId);
  const entry = clients.get(key);
  if (!entry) return;

  if (entry.isStarting) {
    entry.stopRequestedDuringStart = true;
    console.log(`[WhatsApp][${key}] stop requested during start; deferred.`);
    return;
  }

  try {
    console.log(`[WhatsApp][${key}] stopClient destroy requested.`);
    await entry.client.destroy();
    console.log(`[WhatsApp][${key}] stopClient destroy OK.`);
  } catch (_error) {
    // Ignorar cuando el cliente todavía no estaba levantado.
  } finally {
    entry.client.isReady = false;
  }
};

const getClient = (companyId = null) => ensureEntry(companyId).client;

const getReadyClient = (companyId = null) => {
  const key = buildCompanyKey(companyId);
  const entry = clients.get(key);

  if (!entry) {
    throw new Error(
      `No existe cliente de WhatsApp para la empresa '${key}'. Inicializalo primero.`,
    );
  }

  if (entry.isStarting || !entry.hasInitialized) {
    throw new Error(`El cliente de WhatsApp para '${key}' no está inicializado.`);
  }

  if (!entry.client || !entry.client.isReady) {
    throw new Error(`El cliente de WhatsApp para '${key}' no está listo.`);
  }

  return entry.client;
};

const restartClient = async (companyId = null) => {
  const key = buildCompanyKey(companyId);
  const entry = clients.get(key);

  if (entry?.isStarting) {
    throw new Error(
      `Ya hay un arranque en curso para la empresa '${key}'. Reintentá en unos segundos.`,
    );
  }

  console.log(`[WhatsApp][${key}] restart requested.`);
  incrementReconnectAttempts(companyId);

  if (entry?.client) {
    try {
      await entry.client.destroy();
      console.log(`[WhatsApp][${key}] previous client destroyed.`);
    } catch (_error) {
      // Ignorar si no estaba completamente iniciado.
    }
  }

  clients.set(key, createEntry(companyId));
  try {
    const client = await startClient(companyId);
    console.log(`[WhatsApp][${key}] restart OK.`);
    return client;
  } catch (error) {
    setLastError(companyId, error?.message || String(error));
    console.error(
      `[WhatsApp][${key}] restart ERROR:`,
      error?.message || error,
    );
    throw error;
  }
};

module.exports = {
  startClient,
  stopClient,
  getClient,
  getReadyClient,
  restartClient,
};

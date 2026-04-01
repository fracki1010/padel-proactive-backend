const AppConfig = require("../models/appConfig.model");
const client = require("../config/whatsappClient");
const {
  setEnabled,
  setDisabled,
  setInitializing,
  getWhatsappState,
} = require("../state/whatsapp.state");

const CONFIG_KEY = "main";

let isStarting = false;
let stopRequestedDuringStart = false;

async function ensureConfig() {
  const existing = await AppConfig.findOne({ key: CONFIG_KEY });
  if (existing) return existing;

  return AppConfig.create({
    key: CONFIG_KEY,
    whatsappEnabled: false,
  });
}

async function syncWhatsappFromConfig() {
  const config = await ensureConfig();

  if (config.whatsappEnabled) {
    await startWhatsapp();
  } else {
    await stopWhatsapp();
  }

  return config.whatsappEnabled;
}

async function setWhatsappEnabled(enabled) {
  const nextEnabled = Boolean(enabled);

  await AppConfig.findOneAndUpdate(
    { key: CONFIG_KEY },
    { $set: { whatsappEnabled: nextEnabled } },
    { upsert: true, new: true },
  );

  if (nextEnabled) {
    await startWhatsapp();
  } else {
    await stopWhatsapp();
  }

  return getWhatsappState();
}

async function startWhatsapp() {
  setEnabled(true);

  if (client.isReady || isStarting) return;

  stopRequestedDuringStart = false;
  isStarting = true;
  setInitializing("Inicializando cliente de WhatsApp...");

  try {
    await client.initialize();
  } catch (error) {
    setDisabled("No se pudo iniciar WhatsApp");
    setEnabled(false);
    throw error;
  } finally {
    isStarting = false;

    if (stopRequestedDuringStart) {
      stopRequestedDuringStart = false;
      await stopWhatsapp();
    }
  }
}

async function stopWhatsapp() {
  setEnabled(false);
  setDisabled("WhatsApp desactivado manualmente");

  if (isStarting) {
    stopRequestedDuringStart = true;
    return;
  }

  try {
    await client.destroy();
  } catch (_error) {
    // Ignorar errores de cierre cuando el cliente todavía no estaba levantado.
  }
}

module.exports = {
  syncWhatsappFromConfig,
  setWhatsappEnabled,
};

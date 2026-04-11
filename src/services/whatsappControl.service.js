const AppConfig = require("../models/appConfig.model");
const {
  startClient,
  stopClient,
} = require("./whatsappTenantManager.service");
const {
  setEnabled,
  setDisabled,
  setInitializing,
  setStartAttempt,
  setLastError,
  resetReconnectAttempts,
  getWhatsappState,
} = require("../state/whatsapp.state");

const CONFIG_KEY = "main";

const buildConfigFilter = (companyId = null) => ({
  companyId: companyId || null,
  key: CONFIG_KEY,
});

async function ensureConfig(companyId = null) {
  const existing = await AppConfig.findOne(buildConfigFilter(companyId));
  if (existing) return existing;

  return AppConfig.create({
    companyId: companyId || null,
    key: CONFIG_KEY,
    whatsappEnabled: false,
  });
}

async function syncWhatsappFromConfig(companyId = null) {
  const config = await ensureConfig(companyId);

  if (config.whatsappEnabled) {
    await startWhatsapp(companyId);
  } else {
    await stopWhatsapp(companyId);
  }

  return config.whatsappEnabled;
}

async function syncAllWhatsappFromConfig() {
  const configs = await AppConfig.find({ key: CONFIG_KEY });
  console.log(
    `[WhatsApp][sync] Iniciando sincronización de ${configs.length || 1} empresa(s).`,
  );

  if (!configs.length) {
    try {
      await syncWhatsappFromConfig(null);
      console.log("[WhatsApp][global] Sincronización completada.");
    } catch (error) {
      console.error(
        "[WhatsApp][global] Error sincronizando configuración:",
        error?.message || error,
      );
    }
    return;
  }

  for (const config of configs) {
    const companyId = config.companyId || null;
    const companyLabel = companyId || "global";
    const action = config.whatsappEnabled ? "start" : "stop";

    console.log(`[WhatsApp][${companyLabel}] Sync action=${action}.`);
    try {
      if (config.whatsappEnabled) {
        await startWhatsapp(companyId);
      } else {
        await stopWhatsapp(companyId);
      }
      console.log(`[WhatsApp][${companyLabel}] Sync action=${action} OK.`);
    } catch (error) {
      console.error(
        `[WhatsApp][${companyLabel}] Sync action=${action} ERROR:`,
        error?.message || error,
      );
    }
  }
}

async function setWhatsappEnabled(enabled, companyId = null) {
  const nextEnabled = Boolean(enabled);
  const currentConfig = await AppConfig.findOne(buildConfigFilter(companyId));
  const currentState = getWhatsappState(companyId);

  // Evitar reinicializaciones duplicadas (ej: click repetido mientras espera QR)
  if (
    currentConfig &&
    currentConfig.whatsappEnabled === nextEnabled &&
    currentState.enabled === nextEnabled
  ) {
    return currentState;
  }

  await AppConfig.findOneAndUpdate(
    buildConfigFilter(companyId),
    { $set: { whatsappEnabled: nextEnabled } },
    { upsert: true, new: true },
  );

  if (nextEnabled) {
    // Iniciar de forma asíncrona para no bloquear la respuesta HTTP.
    // El frontend ya consulta estado cada 5s y verá qr_pending/ready.
    startWhatsapp(companyId).catch((error) => {
      console.error(
        `[WhatsApp][${companyId || "global"}] Error iniciando sesión:`,
        error?.message || error,
      );
    });
  } else {
    await stopWhatsapp(companyId);
  }

  return getWhatsappState(companyId);
}

async function startWhatsapp(companyId = null) {
  const companyLabel = companyId || "global";
  setEnabled(companyId, true);
  setStartAttempt(companyId, "Inicializando cliente de WhatsApp...");
  setInitializing(companyId, "Inicializando cliente de WhatsApp...");

  try {
    console.log(`[WhatsApp][${companyLabel}] start requested.`);
    await startClient(companyId);
    resetReconnectAttempts(companyId);
    console.log(`[WhatsApp][${companyLabel}] start OK.`);
  } catch (error) {
    const message = String(error?.message || "");
    setLastError(companyId, message || "No se pudo iniciar WhatsApp");
    if (message.includes("The browser is already running for")) {
      setDisabled(
        companyId,
        "La sesión de WhatsApp está siendo usada por otro proceso",
      );
      setEnabled(companyId, false);
      throw new Error(
        "La sesión de WhatsApp de esta empresa ya está abierta en otro proceso. Cerrá la otra instancia del backend y volvé a intentar.",
      );
    }
    setDisabled(companyId, "No se pudo iniciar WhatsApp");
    setEnabled(companyId, false);
    console.error(`[WhatsApp][${companyLabel}] start ERROR:`, message || error);
    throw error;
  }
}

async function stopWhatsapp(companyId = null) {
  const companyLabel = companyId || "global";
  console.log(`[WhatsApp][${companyLabel}] stop requested.`);
  setEnabled(companyId, false);
  setDisabled(companyId, "WhatsApp desactivado manualmente");
  await stopClient(companyId);
  console.log(`[WhatsApp][${companyLabel}] stop OK.`);
}

module.exports = {
  syncWhatsappFromConfig,
  syncAllWhatsappFromConfig,
  setWhatsappEnabled,
};

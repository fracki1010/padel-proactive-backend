const AppConfig = require("../models/appConfig.model");
const {
  startClient,
  stopClient,
} = require("./whatsappTenantManager.service");
const {
  setEnabled,
  setDisabled,
  setInitializing,
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
  if (!configs.length) {
    await syncWhatsappFromConfig(null);
    return;
  }

  await Promise.all(
    configs.map((config) =>
      config.whatsappEnabled
        ? startWhatsapp(config.companyId || null)
        : stopWhatsapp(config.companyId || null),
    ),
  );
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
  setEnabled(companyId, true);
  setInitializing(companyId, "Inicializando cliente de WhatsApp...");

  try {
    await startClient(companyId);
  } catch (error) {
    const message = String(error?.message || "");
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
    throw error;
  }
}

async function stopWhatsapp(companyId = null) {
  setEnabled(companyId, false);
  setDisabled(companyId, "WhatsApp desactivado manualmente");
  await stopClient(companyId);
}

module.exports = {
  syncWhatsappFromConfig,
  syncAllWhatsappFromConfig,
  setWhatsappEnabled,
};

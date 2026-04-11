const GLOBAL_COMPANY_KEY = "global";

const states = new Map();

const buildCompanyKey = (companyId = null) =>
  companyId ? String(companyId) : GLOBAL_COMPANY_KEY;

function createBaseState() {
  return {
    enabled: false,
    status: "disabled",
    qr: null,
    hasQr: false,
    loadingPercent: null,
    loadingMessage: null,
    lastQrAt: null,
    authenticatedAt: null,
    readyAt: null,
    authFailure: null,
    lastError: null,
    lastDisconnectReason: null,
    startingAt: null,
    stoppedAt: null,
    reconnectAttempts: 0,
    updatedAt: new Date().toISOString(),
  };
}

function ensureState(companyId = null) {
  const key = buildCompanyKey(companyId);
  if (!states.has(key)) {
    states.set(key, createBaseState());
  }
  return states.get(key);
}

function touch(state) {
  state.updatedAt = new Date().toISOString();
}

function setEnabled(companyId = null, enabled) {
  const state = ensureState(companyId);
  state.enabled = Boolean(enabled);
  touch(state);
}

function setDisabled(companyId = null, message = "WhatsApp desactivado") {
  const state = ensureState(companyId);
  state.status = "disabled";
  state.qr = null;
  state.hasQr = false;
  state.loadingPercent = null;
  state.loadingMessage = message;
  state.authFailure = null;
  state.stoppedAt = new Date().toISOString();
  touch(state);
}

function setInitializing(companyId = null, message = "Inicializando") {
  const state = ensureState(companyId);
  if (!state.enabled) return;
  state.status = "initializing";
  state.loadingMessage = message;
  state.authFailure = null;
  touch(state);
}

function setStartAttempt(
  companyId = null,
  message = "Inicializando cliente de WhatsApp...",
) {
  const state = ensureState(companyId);
  state.status = "initializing";
  state.startingAt = new Date().toISOString();
  state.loadingMessage = message;
  state.lastError = null;
  touch(state);
}

function setQr(companyId = null, qr) {
  const state = ensureState(companyId);
  if (!state.enabled) return;
  state.status = "qr_pending";
  state.qr = qr;
  state.hasQr = Boolean(qr);
  state.lastQrAt = new Date().toISOString();
  state.authFailure = null;
  touch(state);
}

function setLoading(companyId = null, percent, message) {
  const state = ensureState(companyId);
  if (!state.enabled) return;
  state.status = "loading";
  state.loadingPercent = percent;
  state.loadingMessage = message;
  touch(state);
}

function setAuthenticated(companyId = null) {
  const state = ensureState(companyId);
  if (!state.enabled) return;
  state.status = "authenticated";
  state.qr = null;
  state.hasQr = false;
  state.authFailure = null;
  state.authenticatedAt = new Date().toISOString();
  touch(state);
}

function setAuthFailure(companyId = null, message) {
  const state = ensureState(companyId);
  if (!state.enabled) return;
  state.status = "auth_failure";
  state.authFailure = message || "Error de autenticación";
  state.lastError = state.authFailure;
  touch(state);
}

function setReady(companyId = null) {
  const state = ensureState(companyId);
  if (!state.enabled) return;
  state.status = "ready";
  state.qr = null;
  state.hasQr = false;
  state.loadingPercent = null;
  state.loadingMessage = null;
  state.readyAt = new Date().toISOString();
  state.lastError = null;
  state.lastDisconnectReason = null;
  state.reconnectAttempts = 0;
  touch(state);
}

function setLastError(companyId = null, errorMessage) {
  const state = ensureState(companyId);
  state.lastError =
    typeof errorMessage === "string" && errorMessage.trim()
      ? errorMessage
      : "Error desconocido";
  touch(state);
}

function setDisconnected(companyId = null, reason) {
  const state = ensureState(companyId);
  state.status = "disconnected";
  state.qr = null;
  state.hasQr = false;
  state.loadingPercent = null;
  state.loadingMessage = "Cliente desconectado";
  state.lastDisconnectReason =
    typeof reason === "string" && reason.trim()
      ? reason
      : reason != null
        ? String(reason)
        : "desconocido";
  state.stoppedAt = new Date().toISOString();
  touch(state);
}

function incrementReconnectAttempts(companyId = null) {
  const state = ensureState(companyId);
  state.reconnectAttempts = Number(state.reconnectAttempts || 0) + 1;
  touch(state);
}

function resetReconnectAttempts(companyId = null) {
  const state = ensureState(companyId);
  state.reconnectAttempts = 0;
  touch(state);
}

function getWhatsappState(companyId = null) {
  return { ...ensureState(companyId) };
}

function getAllWhatsappStates() {
  const result = {};
  for (const [key, value] of states.entries()) {
    result[key] = { ...value };
  }
  return result;
}

module.exports = {
  buildCompanyKey,
  getWhatsappState,
  getAllWhatsappStates,
  setEnabled,
  setDisabled,
  setInitializing,
  setStartAttempt,
  setQr,
  setLoading,
  setAuthenticated,
  setAuthFailure,
  setReady,
  setLastError,
  setDisconnected,
  incrementReconnectAttempts,
  resetReconnectAttempts,
};

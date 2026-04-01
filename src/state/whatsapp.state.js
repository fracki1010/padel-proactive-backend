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
  setQr,
  setLoading,
  setAuthenticated,
  setAuthFailure,
  setReady,
};

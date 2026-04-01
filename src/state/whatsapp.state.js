const state = {
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

function touch() {
  state.updatedAt = new Date().toISOString();
}

function setEnabled(enabled) {
  state.enabled = Boolean(enabled);
  touch();
}

function setDisabled(message = "WhatsApp desactivado") {
  state.status = "disabled";
  state.qr = null;
  state.hasQr = false;
  state.loadingPercent = null;
  state.loadingMessage = message;
  state.authFailure = null;
  touch();
}

function setInitializing(message = "Inicializando") {
  if (!state.enabled) return;
  state.status = "initializing";
  state.loadingMessage = message;
  state.authFailure = null;
  touch();
}

function setQr(qr) {
  if (!state.enabled) return;
  state.status = "qr_pending";
  state.qr = qr;
  state.hasQr = Boolean(qr);
  state.lastQrAt = new Date().toISOString();
  state.authFailure = null;
  touch();
}

function setLoading(percent, message) {
  if (!state.enabled) return;
  state.status = "loading";
  state.loadingPercent = percent;
  state.loadingMessage = message;
  touch();
}

function setAuthenticated() {
  if (!state.enabled) return;
  state.status = "authenticated";
  state.qr = null;
  state.hasQr = false;
  state.authFailure = null;
  state.authenticatedAt = new Date().toISOString();
  touch();
}

function setAuthFailure(message) {
  if (!state.enabled) return;
  state.status = "auth_failure";
  state.authFailure = message || "Error de autenticación";
  touch();
}

function setReady() {
  if (!state.enabled) return;
  state.status = "ready";
  state.qr = null;
  state.hasQr = false;
  state.loadingPercent = null;
  state.loadingMessage = null;
  state.readyAt = new Date().toISOString();
  touch();
}

function getWhatsappState() {
  return { ...state };
}

module.exports = {
  setEnabled,
  setDisabled,
  setInitializing,
  setQr,
  setLoading,
  setAuthenticated,
  setAuthFailure,
  setReady,
  getWhatsappState,
};

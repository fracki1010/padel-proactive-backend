const state = {
  status: "initializing",
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

function setQr(qr) {
  state.status = "qr_pending";
  state.qr = qr;
  state.hasQr = Boolean(qr);
  state.lastQrAt = new Date().toISOString();
  state.authFailure = null;
  touch();
}

function setLoading(percent, message) {
  state.status = "loading";
  state.loadingPercent = percent;
  state.loadingMessage = message;
  touch();
}

function setAuthenticated() {
  state.status = "authenticated";
  state.qr = null;
  state.hasQr = false;
  state.authFailure = null;
  state.authenticatedAt = new Date().toISOString();
  touch();
}

function setAuthFailure(message) {
  state.status = "auth_failure";
  state.authFailure = message || "Error de autenticación";
  touch();
}

function setReady() {
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
  setQr,
  setLoading,
  setAuthenticated,
  setAuthFailure,
  setReady,
  getWhatsappState,
};

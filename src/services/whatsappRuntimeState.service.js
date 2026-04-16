const WhatsappRuntimeState = require("../models/whatsappRuntimeState.model");

const createBaseState = () => ({
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
});

const normalizeCompanyId = (companyId = null) => companyId || null;
const toTs = (value = null) => {
  if (typeof value !== "string" || !value.trim()) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeStateDoc = (doc = null) => {
  if (!doc) return createBaseState();

  const normalized = {
    enabled: Boolean(doc.enabled),
    status: String(doc.status || "disabled"),
    qr: typeof doc.qr === "string" ? doc.qr : null,
    hasQr: Boolean(doc.hasQr),
    loadingPercent:
      typeof doc.loadingPercent === "number" ? doc.loadingPercent : null,
    loadingMessage:
      typeof doc.loadingMessage === "string" ? doc.loadingMessage : null,
    lastQrAt: typeof doc.lastQrAt === "string" ? doc.lastQrAt : null,
    authenticatedAt:
      typeof doc.authenticatedAt === "string" ? doc.authenticatedAt : null,
    readyAt: typeof doc.readyAt === "string" ? doc.readyAt : null,
    authFailure: typeof doc.authFailure === "string" ? doc.authFailure : null,
    lastError: typeof doc.lastError === "string" ? doc.lastError : null,
    lastDisconnectReason:
      typeof doc.lastDisconnectReason === "string"
        ? doc.lastDisconnectReason
        : null,
    startingAt: typeof doc.startingAt === "string" ? doc.startingAt : null,
    stoppedAt: typeof doc.stoppedAt === "string" ? doc.stoppedAt : null,
    reconnectAttempts: Number(doc.reconnectAttempts || 0),
    updatedAt:
      typeof doc.updatedAtIso === "string" && doc.updatedAtIso
        ? doc.updatedAtIso
        : doc.updatedAt instanceof Date
          ? doc.updatedAt.toISOString()
          : new Date().toISOString(),
  };

  const readyIsNewerThanQr =
    toTs(normalized.readyAt) > 0 && toTs(normalized.readyAt) >= toTs(normalized.lastQrAt);

  // Estado contradictorio típico por carreras de persistencia asíncrona: ready ya ocurrió,
  // pero quedó guardado qr_pending más viejo.
  if (normalized.enabled && readyIsNewerThanQr && normalized.status === "qr_pending") {
    normalized.status = "ready";
    normalized.qr = null;
    normalized.hasQr = false;
    normalized.loadingMessage = null;
  }

  return normalized;
};

const saveWhatsappRuntimeState = async (companyId = null, state = {}) => {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  const normalizedState = {
    enabled: Boolean(state.enabled),
    status: String(state.status || "disabled"),
    qr: typeof state.qr === "string" ? state.qr : null,
    hasQr: Boolean(state.hasQr),
    loadingPercent:
      typeof state.loadingPercent === "number" ? state.loadingPercent : null,
    loadingMessage:
      typeof state.loadingMessage === "string" ? state.loadingMessage : null,
    lastQrAt: typeof state.lastQrAt === "string" ? state.lastQrAt : null,
    authenticatedAt:
      typeof state.authenticatedAt === "string" ? state.authenticatedAt : null,
    readyAt: typeof state.readyAt === "string" ? state.readyAt : null,
    authFailure: typeof state.authFailure === "string" ? state.authFailure : null,
    lastError: typeof state.lastError === "string" ? state.lastError : null,
    lastDisconnectReason:
      typeof state.lastDisconnectReason === "string"
        ? state.lastDisconnectReason
        : null,
    startingAt: typeof state.startingAt === "string" ? state.startingAt : null,
    stoppedAt: typeof state.stoppedAt === "string" ? state.stoppedAt : null,
    reconnectAttempts: Number(state.reconnectAttempts || 0),
    updatedAtIso:
      typeof state.updatedAt === "string" && state.updatedAt
        ? state.updatedAt
        : new Date().toISOString(),
  };

  await WhatsappRuntimeState.findOneAndUpdate(
    {
      companyId: normalizedCompanyId,
      $or: [
        { updatedAtIso: { $exists: false } },
        { updatedAtIso: null },
        { updatedAtIso: { $lte: normalizedState.updatedAtIso } },
      ],
    },
    { $set: { companyId: normalizedCompanyId, ...normalizedState } },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
};

const getWhatsappRuntimeState = async (companyId = null) => {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  const doc = await WhatsappRuntimeState.findOne({
    companyId: normalizedCompanyId,
  }).lean();

  return normalizeStateDoc(doc);
};

module.exports = {
  createBaseState,
  saveWhatsappRuntimeState,
  getWhatsappRuntimeState,
};

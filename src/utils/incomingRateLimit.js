'use strict';

const { normalizeSpanishText } = require('../whatsapp/domain/messageSanitization');

const INCOMING_RATE_WINDOW_MS = Number(
  process.env.WHATSAPP_BOT_RATE_WINDOW_MS || 60 * 1000,
);
const INCOMING_RATE_MAX_MESSAGES = Number(
  process.env.WHATSAPP_BOT_RATE_MAX_MESSAGES || 14,
);
const INCOMING_RATE_MAX_CONTROL_MESSAGES = Number(
  process.env.WHATSAPP_BOT_RATE_MAX_CONTROL_MESSAGES || 8,
);
const incomingRateState = new Map();
const MAX_SAME_MESSAGE_BEFORE_LOOP_REPLY = 3;

const fingerprintMessage = (value = "") =>
  normalizeSpanishText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const auditSecurityEvent = ({
  companyId = null,
  chatId = "",
  sessionId = "",
  event = "UNKNOWN",
  reason = "",
  userMessage = "",
  meta = {},
}) => {
  const payload = {
    ts: new Date().toISOString(),
    event,
    reason,
    companyId: companyId || "global",
    chatId: String(chatId || ""),
    sessionId: String(sessionId || ""),
    messagePreview: String(userMessage || "").slice(0, 180),
    ...meta,
  };
  console.warn(`[BotSecurity][${companyId || "global"}] ${JSON.stringify(payload)}`);
};

const enforceIncomingRateLimit = ({
  sessionId = "",
  companyId = null,
  chatId = "",
  userMessage = "",
  isControlMessage = false,
}) => {
  const now = Date.now();
  const safeWindowMs = Number.isFinite(INCOMING_RATE_WINDOW_MS)
    ? Math.max(10 * 1000, INCOMING_RATE_WINDOW_MS)
    : 60 * 1000;
  const safeMaxMessages = Number.isFinite(INCOMING_RATE_MAX_MESSAGES)
    ? Math.max(4, INCOMING_RATE_MAX_MESSAGES)
    : 14;
  const safeMaxControlMessages = Number.isFinite(INCOMING_RATE_MAX_CONTROL_MESSAGES)
    ? Math.max(2, INCOMING_RATE_MAX_CONTROL_MESSAGES)
    : 8;

  const previous = incomingRateState.get(sessionId);
  const bucket =
    previous && now - previous.windowStart < safeWindowMs
      ? previous
      : { windowStart: now, totalCount: 0, controlCount: 0 };

  bucket.totalCount += 1;
  if (isControlMessage) bucket.controlCount += 1;

  incomingRateState.set(sessionId, bucket);
  if (incomingRateState.size > 5000) {
    for (const [key, value] of incomingRateState.entries()) {
      if (now - Number(value.windowStart || 0) > safeWindowMs * 3) {
        incomingRateState.delete(key);
      }
    }
  }

  if (bucket.totalCount > safeMaxMessages || bucket.controlCount > safeMaxControlMessages) {
    const waitSeconds = Math.max(
      1,
      Math.ceil((safeWindowMs - (now - bucket.windowStart)) / 1000),
    );
    auditSecurityEvent({
      companyId,
      chatId,
      sessionId,
      event: "RATE_LIMIT_BLOCKED",
      reason:
        bucket.controlCount > safeMaxControlMessages
          ? "too_many_control_messages"
          : "too_many_messages",
      userMessage,
      meta: {
        waitSeconds,
        totalCount: bucket.totalCount,
        controlCount: bucket.controlCount,
      },
    });
    return {
      blocked: true,
      reply:
        `⚠️ Estoy recibiendo demasiados mensajes seguidos para procesar sin errores.\n` +
        `Esperá *${waitSeconds}s* y enviá un solo mensaje concreto (ej: *hoy 20:00* o *CONFIRMAR RESERVA*).`,
    };
  }

  return { blocked: false, reply: null };
};

module.exports = {
  INCOMING_RATE_WINDOW_MS,
  INCOMING_RATE_MAX_MESSAGES,
  INCOMING_RATE_MAX_CONTROL_MESSAGES,
  incomingRateState,
  MAX_SAME_MESSAGE_BEFORE_LOOP_REPLY,
  fingerprintMessage,
  auditSecurityEvent,
  enforceIncomingRateLimit,
};
const normalizeSpanishText = (text = "") =>
  String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const normalizeLooseText = (value = "") =>
  normalizeSpanishText(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isEquivalentConfirmation = (value = "", extra = []) => {
  const text = normalizeLooseText(value);
  if (!text) return false;

  const defaults = new Set([
    "si",
    "si por favor",
    "dale",
    "ok",
    "okay",
    "confirmar",
    "confirmo",
    "confirmado",
    "confirmar reserva",
    "confirmar turno",
    "listo",
  ]);
  for (const item of extra || []) {
    const normalized = normalizeLooseText(item);
    if (normalized) defaults.add(normalized);
  }

  if (defaults.has(text)) return true;
  return /^(si|dale|ok|confirmar|confirmo|listo)\b/.test(text);
};

const parseGlobalInterruptIntent = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return null;

  if (
    /^(empezar de nuevo|reiniciar|resetear|reset|arrancar de nuevo|comenzar de nuevo)$/.test(
      text,
    )
  ) {
    return { action: "RESET_FLOW" };
  }

  if (
    /(hablar con admin|hablar con administrador|quiero hablar con admin|quiero hablar con administrador|pasame con admin|pasame con administrador)/.test(
      text,
    )
  ) {
    return { action: "TALK_TO_ADMIN" };
  }

  if (
    /(disponibilidad|hay lugar|tenes lugar|tenes algo|horarios disponibles|que horarios hay)/.test(
      text,
    )
  ) {
    return { action: "CHECK_AVAILABILITY" };
  }

  if (/^(cancelar|cancelar reserva|cancelar turno)$/.test(text)) {
    return { action: "CANCEL_BOOKING" };
  }

  return null;
};

const isInterruptibleAction = (action = "") =>
  action === "LIST_ACTIVE_BOOKINGS" ||
  action === "CANCEL_BOOKING" ||
  action === "CHECK_AVAILABILITY";

const shouldAllowStrictStateInterrupt = (state = null, action = "") => {
  if (!state || !isInterruptibleAction(action)) return false;
  if (state === "ATTENDANCE_CONFIRMATION") return false;
  return true;
};

const shouldBlockRejectedSlotReattempt = ({
  rejectedBookingAttempt = null,
  requestedDate = "",
  requestedTime = "",
}) => {
  if (!rejectedBookingAttempt?.dateStr || !rejectedBookingAttempt?.timeStr) {
    return false;
  }
  if (!requestedDate || !requestedTime) return false;
  return (
    String(rejectedBookingAttempt.dateStr) === String(requestedDate) &&
    String(rejectedBookingAttempt.timeStr) === String(requestedTime)
  );
};

module.exports = {
  isEquivalentConfirmation,
  parseGlobalInterruptIntent,
  isInterruptibleAction,
  shouldAllowStrictStateInterrupt,
  shouldBlockRejectedSlotReattempt,
};

'use strict';

const { startsWithJsonObject } = require('../whatsapp/domain/extractModelJson');

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
  return /^(dale|ok|confirmar|confirmo|listo)\b/.test(text);
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
    /(hablar con(?: un)? admin(?:istrador)?|quiero hablar con(?: un)? admin(?:istrador)?|pasame con(?: un)? admin(?:istrador)?)/.test(
      text,
    )
  ) {
    return { action: "TALK_TO_ADMIN" };
  }

  if (
    /(ver disponibilidad|disponibilidad|hay lugar|tenes lugar|tenes algo|horarios disponibles|que horarios hay)/.test(
      text,
    ) ||
    /(cual(?:es)? (?:esta|estan) (?:disponible|disponibles|libre|libres)|que (?:esta|hay) (?:disponible|libre)|que horarios? (?:hay|tenes)|tenes algo (?:disponible|libre)|hay (?:opciones?|alternativas))/.test(
      text,
    )
  ) {
    return { action: "CHECK_AVAILABILITY" };
  }

  if (/\b(cancelar|cancelo|cancelame|cancela|anular|anulo|anulado|anulada|anula|dar de baja)\b/.test(text)) {
    return { action: "CANCEL_BOOKING" };
  }

  if (/(mis reservas|que tengo reservado|que turnos tengo|lista de reservas)/.test(text)) {
    return { action: "LIST_ACTIVE_BOOKINGS" };
  }

  if (/(reservar|quiero reservar|anotame|agendame|hace la reserva|confirma.*turno)/.test(text)) {
    return { action: "CREATE_BOOKING" };
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

// El usuario pide alternativas tras un rechazo de horario ("cuál está disponible",
// "dame otro horario", "mostrame opciones"). Requiere ambos grupos: el introductor
// (que/cuál/otro/dame/mostrame) y el sustantivo objetivo (disponible/libre/opciones/
// horarios/alternativas), para no dispararse en charla casual ("estoy libre").
const REJECTED_SLOT_ALTERNATIVES_PATTERN =
  /(que|cu[aá]l(?:es)?|otr[oa]s?|dame|mostr[aá](?:me|s))\b.*(disponible|libre|opciones?|horarios?|alternativas?)/;

// P0 (elección concreta post-rechazo): cuando la sesión tiene un contexto de
// disponibilidad (lastRejectedBookingAttempt.dateStr o lastAvailabilityDate) y el
// usuario elige UNA opción concreta ("17:00", "la primera", "techada"), el bot debe
// resolverla determinísticamente sin depender de la IA (que puede devolver JSON
// truncado/malformado y filtrarlo como texto). Devuelve:
//   { type: "time", value: "HH:mm" } | { type: "court", value } | { type: "ordinal", index } | null
const parseConcreteAlternativeChoice = (value = "") => {
  const raw = String(value || "").trim();
  if (!raw) return null;

  // "las 5" / "a las 17" → hora con convención pm para valores ≤ 6
  const lasMatch = raw.match(/^\s*(?:a\s+)?las\s+(\d{1,2})(?::(\d{2}))?\s*$/i);
  if (lasMatch) {
    const hh = Number(lasMatch[1]);
    const mm = lasMatch[2] ? Number(lasMatch[2]) : 0;
    const hour24 = hh <= 6 ? hh + 12 : hh;
    if (hour24 <= 23 && mm <= 59) {
      return { type: "time", value: `${String(hour24).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
    }
    return null;
  }

  // "17:00" / "5:30" → hora explícita
  const colonMatch = raw.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (colonMatch) {
    const hh = Number(colonMatch[1]);
    const mm = Number(colonMatch[2]);
    if (hh <= 23 && mm <= 59) {
      return { type: "time", value: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
    }
    return null;
  }

  // "17hs" / "17 hs" / "5 horas" → hora con sufijo
  const suffixedMatch = raw.match(/^\s*(\d{1,2})\s*(?:hs|horas?)\s*$/i);
  if (suffixedMatch) {
    const hh = Number(suffixedMatch[1]);
    if (hh <= 23) {
      return { type: "time", value: `${String(hh).padStart(2, "0")}:00` };
    }
    return null;
  }

  // "17" pelado → hora solo si es inequívoca (7-23); si no, cae a ordinal
  const bareNumber = raw.match(/^\s*(\d{1,2})\s*$/);
  if (bareNumber) {
    const n = Number(bareNumber[1]);
    if (n >= 7 && n <= 23) {
      return { type: "time", value: `${String(n).padStart(2, "0")}:00` };
    }
  }

  const text = normalizeLooseText(value);

  // "la primera" / "el primero" / "la 2" / "la tercera" → ordinal (0-based)
  const ORDINAL_INDEX = {
    primera: 0,
    primero: 0,
    "1ra": 0,
    "1ro": 0,
    segunda: 1,
    segundo: 1,
    "2da": 1,
    "2do": 1,
    tercera: 2,
    tercero: 2,
    "3ra": 2,
    "3ro": 2,
    cuarta: 3,
    cuarto: 3,
    "4ta": 3,
    quinta: 4,
    quinto: 4,
    "5ta": 4,
  };
  const ordinalMatch = text.match(/^(?:la|el|la opcion|la opción)?\s*(primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto|quinta|quinto|1ra|1ro|2da|2do|3ra|3ro|4ta|5ta|\d{1,2})\s*$/);
  if (ordinalMatch) {
    const key = ordinalMatch[1];
    const index = ORDINAL_INDEX[key] ?? (/\d{1,2}/.test(key) ? Number(key) - 1 : null);
    if (index !== null && index >= 0) return { type: "ordinal", index };
  }

  // "techada" / "la techada" / "descubierta" → tipo de cancha
  const courtMatch = text.match(/^(?:la|el|cancha)?\s*(techada|descubierta|semi techada|indiferente)\s*$/);
  if (courtMatch) return { type: "court", value: courtMatch[1] };

  return null;
};

const isRejectedSlotAlternativeRequest = (value = "") => {
  const text = normalizeLooseText(value);
  if (!text) return false;
  if (REJECTED_SLOT_ALTERNATIVES_PATTERN.test(text)) return true;
  // P0: elecciones concretas ("17:00", "la primera", "techada") también cuentan
  return parseConcreteAlternativeChoice(value) !== null;
};

const SAFE_FALLBACK_REPLY =
  "No entendí. Decime qué horario querés (ej: mañana 20:00) o escribí 'disponibilidad'.";

// Garantiza que el bot nunca emite un reply vacío: un mensaje vacío se descarta
// silenciosamente en el worker (internal.routes.js) y deja al usuario sin respuesta.
const resolveSafeBotReply = (value = "") => {
  const reply = String(value || "").trim();
  if (!reply) return SAFE_FALLBACK_REPLY;
  return reply;
};

// P0 (guarda de salida): cualquier reply que arranque como payload JSON crudo
// (truncado/malformado) se reemplaza por el nudge seguro. Defensa en profundidad:
// el handler ya no debe producir estos replies, pero esta guarda cubre cualquier
// ruta futura (por ejemplo respuestas que llegan directo del modelo).
const sanitizeOutgoingReply = (value = "") => {
  const reply = String(value || "").trim();
  if (!reply) return reply;
  if (startsWithJsonObject(reply)) return SAFE_FALLBACK_REPLY;
  return reply;
};

// Mapea el resultado de createNewBooking a un lastRejectedBookingAttempt, solo cuando
// el motivo es INVALID_TIME (horario inexistente en la grilla). Así el follow-up
// "cuál está disponible" puede recuperar la fecha del intento rechazado.
const buildRejectedBookingAttempt = ({
  dateStr = "",
  timeStr = "",
  bookingResult = null,
} = {}) => {
  if (!dateStr || !timeStr) return null;
  if (bookingResult?.error !== "INVALID_TIME") return null;
  return { dateStr, timeStr, reason: "INVALID_TIME" };
};

module.exports = {
  isEquivalentConfirmation,
  parseGlobalInterruptIntent,
  isInterruptibleAction,
  shouldAllowStrictStateInterrupt,
  shouldBlockRejectedSlotReattempt,
  isRejectedSlotAlternativeRequest,
  parseConcreteAlternativeChoice,
  sanitizeOutgoingReply,
  resolveSafeBotReply,
  buildRejectedBookingAttempt,
  SAFE_FALLBACK_REPLY,
};

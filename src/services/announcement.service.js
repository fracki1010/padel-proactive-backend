"use strict";

// Club announcements domain logic. Kept as pure functions so the time-window
// filter and payload validation can be tested without a live MongoDB.

const ANNOUNCEMENT_TYPES = ["info", "important", "promo"];

/**
 * Mongo filter for the public board: announcements that belong to the club,
 * are active, and whose optional window contains `now`. A null bound means
 * "no limit" (starts immediately / never ends).
 */
const buildActiveAnnouncementsQuery = (companyId, now = new Date()) => ({
  companyId,
  isActive: true,
  $and: [
    { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
    { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
  ],
});

const parseOptionalDate = (value) => {
  if (value === null || value === undefined || value === "") {
    return { valid: true, value: null };
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return { valid: false, value: null };
  return { valid: true, value: parsed };
};

/**
 * Validates and normalizes an announcement payload.
 * - partial=false (create): title and message are required.
 * - partial=true (update): only provided fields are validated.
 * Returns `{ data, errors }`; `data` only contains valid, coerced fields.
 */
const validateAnnouncementInput = (body = {}, { partial = false } = {}) => {
  const source = body && typeof body === "object" ? body : {};
  const errors = [];
  const data = {};

  if (source.title !== undefined) {
    const title = String(source.title).trim();
    if (!title) errors.push("title es obligatorio.");
    else data.title = title;
  } else if (!partial) {
    errors.push("title es obligatorio.");
  }

  if (source.message !== undefined) {
    const message = String(source.message).trim();
    if (!message) errors.push("message es obligatorio.");
    else data.message = message;
  } else if (!partial) {
    errors.push("message es obligatorio.");
  }

  if (source.type !== undefined && source.type !== null && source.type !== "") {
    if (!ANNOUNCEMENT_TYPES.includes(source.type)) {
      errors.push(`type debe ser uno de: ${ANNOUNCEMENT_TYPES.join(", ")}.`);
    } else {
      data.type = source.type;
    }
  }

  if (source.isActive !== undefined) {
    if (typeof source.isActive !== "boolean") {
      errors.push("isActive debe ser booleano.");
    } else {
      data.isActive = source.isActive;
    }
  }

  if (source.startsAt !== undefined) {
    const startsAt = parseOptionalDate(source.startsAt);
    if (!startsAt.valid) errors.push("startsAt debe ser una fecha válida o null.");
    else data.startsAt = startsAt.value;
  }

  if (source.endsAt !== undefined) {
    const endsAt = parseOptionalDate(source.endsAt);
    if (!endsAt.valid) errors.push("endsAt debe ser una fecha válida o null.");
    else data.endsAt = endsAt.value;
  }

  if (source.order !== undefined) {
    const order = Number(source.order);
    if (Number.isNaN(order)) errors.push("order debe ser numérico.");
    else data.order = order;
  }

  if (
    data.startsAt instanceof Date &&
    data.endsAt instanceof Date &&
    data.startsAt.getTime() > data.endsAt.getTime()
  ) {
    errors.push("startsAt no puede ser posterior a endsAt.");
  }

  return { data, errors };
};

module.exports = {
  ANNOUNCEMENT_TYPES,
  buildActiveAnnouncementsQuery,
  validateAnnouncementInput,
};

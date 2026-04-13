const { getWhatsappState } = require("../state/whatsapp.state");
const { getReadyClient } = require("./whatsappTenantManager.service");
const {
  getWhatsappCancellationGroupSettings,
} = require("./appConfig.service");

const normalizeChatId = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.endsWith("@g.us")) return raw;
  return `${raw}@g.us`;
};

const TIMEZONE = "America/Argentina/Buenos_Aires";

const getIsoDateInTimezone = (value, timeZone = TIMEZONE) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
};

const getBookingIsoDate = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
};

const getTodayIsoInTimezone = (timeZone = TIMEZONE) => {
  return getIsoDateInTimezone(new Date(), timeZone);
};

const isTodayInTimezone = (value, timeZone = TIMEZONE) => {
  return getBookingIsoDate(value) === getTodayIsoInTimezone(timeZone);
};

const formatCancellationMessage = ({ time, courtName }) => {
  return [
    "🎾 *Turno liberado*",
    "",
    `⏰ *Hora:* ${time || "N/D"}`,
    `🏟️ *Cancha:* ${courtName || "N/D"}`,
    "",
    "Si te interesa, pedilo por este chat.",
  ].join("\n");
};

const notifyCancellationToGroup = async ({
  companyId = null,
  booking,
  time,
  courtName,
}) => {
  if (!isTodayInTimezone(booking?.date)) {
    return { sent: false, reason: "booking_not_today" };
  }

  const settings = await getWhatsappCancellationGroupSettings(companyId);
  if (!settings.enabled) {
    return { sent: false, reason: "group_alerts_disabled" };
  }

  const groupId = normalizeChatId(settings.groupId);
  if (!groupId || !groupId.endsWith("@g.us")) {
    return { sent: false, reason: "missing_or_invalid_group_id" };
  }

  const state = getWhatsappState(companyId);
  if (!state.enabled) {
    return { sent: false, reason: "whatsapp_disabled" };
  }

  let client;
  try {
    client = getReadyClient(companyId);
  } catch (_error) {
    return { sent: false, reason: "client_not_ready" };
  }

  const message = formatCancellationMessage({
    time: time || booking?.timeSlot?.startTime,
    courtName: courtName || booking?.court?.name,
  });

  await client.sendMessage(groupId, message);
  return { sent: true, groupId };
};

const listWhatsappGroups = async (companyId = null) => {
  const client = getReadyClient(companyId);
  const chats = await client.getChats();

  const groups = chats
    .filter((chat) => Boolean(chat?.isGroup))
    .map((chat) => ({
      id: normalizeChatId(chat?.id?._serialized || chat?.id || ""),
      name: String(chat?.name || chat?.formattedTitle || "").trim(),
    }))
    .filter((group) => group.id.endsWith("@g.us"))
    .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));

  return groups;
};

module.exports = {
  notifyCancellationToGroup,
  listWhatsappGroups,
  getIsoDateInTimezone,
  getTodayIsoInTimezone,
};

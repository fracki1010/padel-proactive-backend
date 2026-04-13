const { formatBookingDateShort } = require("../utils/formatBookingDateShort");
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

const formatCancellationMessage = ({
  clientName,
  date,
  time,
  courtName,
  cancelledBy = "sistema",
}) => {
  return [
    "🎾 *Turno liberado*",
    "",
    `👤 *Cliente:* ${clientName || "N/D"}`,
    `📅 *Fecha:* ${formatBookingDateShort(date)}`,
    `⏰ *Hora:* ${time || "N/D"}`,
    `🏟️ *Cancha:* ${courtName || "N/D"}`,
    "",
    `ℹ️ Cancelado por: ${cancelledBy}`,
    "Si te interesa, pedilo por este mismo número.",
  ].join("\n");
};

const notifyCancellationToGroup = async ({
  companyId = null,
  booking,
  time,
  courtName,
  cancelledBy = "sistema",
}) => {
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
    clientName: booking?.clientName,
    date: booking?.date,
    time: time || booking?.timeSlot?.startTime,
    courtName: courtName || booking?.court?.name,
    cancelledBy,
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
};

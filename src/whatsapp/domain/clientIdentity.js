const TRANSPORT_PREFIX_REGEX = /^([a-z_-]+):(.*)$/i;

const normalizeRaw = (value = "") => String(value || "").trim().toLowerCase();

const isQaSession = (value = "") => {
  const raw = normalizeRaw(value);
  return raw.startsWith("qa-") || raw.startsWith("qa_") || raw.startsWith("qa:") || raw.includes("qa-defensive");
};

const unwrapTransportPrefix = (value = "") => {
  const raw = normalizeRaw(value);
  if (!raw) return "";
  const match = raw.match(TRANSPORT_PREFIX_REGEX);
  if (!match) return raw;

  const prefix = String(match[1] || "").trim();
  const rest = String(match[2] || "").trim();
  if (!rest) return raw;
  if (!/\d/.test(prefix) && !isQaSession(raw)) return rest;
  return raw;
};

const normalizePhoneDigits = (value = "") => {
  const raw = unwrapTransportPrefix(value);
  const local = raw.includes("@") ? raw.split("@")[0] : raw;
  return String(local || "").replace(/\D/g, "");
};

const toE164 = (digits = "") => {
  const clean = String(digits || "").replace(/\D/g, "");
  return clean ? `+${clean}` : "";
};

const normalizeWhatsappId = (value = "") => {
  const raw = unwrapTransportPrefix(value);
  if (!raw) return "";
  if (isQaSession(value)) return normalizeRaw(value);
  if (!raw.includes("@")) {
    const digits = normalizePhoneDigits(raw);
    return digits || raw;
  }
  const [local, domain] = raw.split("@");
  return `${String(local || "").trim()}@${String(domain || "").trim()}`;
};

const buildWhatsappKeys = ({ whatsappId = "", chatId = "", canonicalPhoneDigits = "" } = {}) => {
  const keys = new Set();
  const values = [whatsappId, chatId].filter(Boolean);

  for (const value of values) {
    const normalized = normalizeWhatsappId(value);
    if (!normalized) continue;
    if (isQaSession(value)) {
      keys.add(`qa:${normalized}`);
      // Extraer phone embebido en chatIds QA como "qa-server:5491234567@lid"
      // Esto permite que reservas hechas en sesión QA se matcheen con el usuario real
      const rawVal = normalizeRaw(value);
      const qaEmbedMatch = rawVal.match(/^[a-z_-]+:(.+)$/i);
      if (qaEmbedMatch?.[1]) {
        const embeddedPart = String(qaEmbedMatch[1] || "");
        const embeddedDigits = embeddedPart.split("@")[0].replace(/\D/g, "");
        if (embeddedDigits.length >= 6) {
          keys.add(`wa:${embeddedDigits}`);
          keys.add(`phone:${embeddedDigits}`);
        }
      }
      continue;
    }
    if (normalized.includes("@")) {
      const [local] = normalized.split("@");
      keys.add(`wa:${local}`);
      keys.add(`wafull:${normalized}`);
      const digits = normalizePhoneDigits(local);
      if (digits) keys.add(`phone:${digits}`);
    } else {
      const digits = normalizePhoneDigits(normalized);
      if (digits) keys.add(`phone:${digits}`);
      keys.add(`wa:${normalized}`);
    }
  }

  if (canonicalPhoneDigits) keys.add(`phone:${canonicalPhoneDigits}`);
  return [...keys];
};

const normalizeClientIdentity = (input = {}) => {
  const phone = input.phone || "";
  const whatsappIdRaw = input.whatsappId || "";
  const chatIdRaw = input.chatId || "";

  const canonicalPhoneDigits =
    normalizePhoneDigits(input.canonicalClientPhone || "") ||
    normalizePhoneDigits(phone) ||
    normalizePhoneDigits(whatsappIdRaw) ||
    normalizePhoneDigits(chatIdRaw);

  const canonicalPhone = toE164(canonicalPhoneDigits);
  const normalizedWhatsappId = normalizeWhatsappId(whatsappIdRaw || chatIdRaw || "");
  const qaSession = isQaSession(chatIdRaw) || isQaSession(whatsappIdRaw);
  const channelType = qaSession ? "qa" : "whatsapp";

  const whatsappKeys = buildWhatsappKeys({
    whatsappId: whatsappIdRaw,
    chatId: chatIdRaw,
    canonicalPhoneDigits,
  });

  return {
    canonicalPhone,
    canonicalPhoneDigits,
    whatsappId: normalizedWhatsappId,
    whatsappKeys,
    channelType,
    isQaSession: qaSession,
  };
};

module.exports = {
  normalizeClientIdentity,
  normalizePhoneDigits,
  normalizeWhatsappId,
  toE164,
  isQaSession,
};

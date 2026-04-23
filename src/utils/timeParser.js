const normalizeText = (value = "") => String(value || "").trim().toLowerCase();

const parseTime = (input = "") => {
  const text = normalizeText(input);
  if (!text) return null;

  const fullMatch = text.match(/^([01]?\d|2[0-3])[:.]([0-5]\d)$/);
  if (fullMatch) {
    return `${String(fullMatch[1]).padStart(2, "0")}:${fullMatch[2]}`;
  }

  const hourOnlyMatch = text.match(/^([01]?\d|2[0-3])$/);
  if (hourOnlyMatch) {
    return `${String(hourOnlyMatch[1]).padStart(2, "0")}:00`;
  }

  return null;
};

const hasInvalidTimeInput = (rawText = "") => {
  const text = String(rawText || "");
  const candidates = text.match(/\b\d{1,2}[:.]\d{1,2}\b/g) || [];
  if (!candidates.length) return false;
  return candidates.some((candidate) => !parseTime(candidate));
};

const hasCompactInvalidTime = (rawText = "") => {
  const text = String(rawText || "");
  const compact4 = text.match(/\b\d{4}\b/g) || [];
  if (compact4.some((m) => {
    const h = Math.floor(Number(m) / 100);
    const min = Number(m) % 100;
    return h > 23 || min > 59;
  })) return true;
  if (/\b\d{3}\b/.test(text)) return true;
  return false;
};

module.exports = {
  parseTime,
  hasInvalidTimeInput,
  hasCompactInvalidTime,
};

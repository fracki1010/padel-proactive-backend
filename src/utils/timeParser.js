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

module.exports = {
  parseTime,
  hasInvalidTimeInput,
};

const normalizeUnicode = (value = "") => String(value || "").normalize("NFC");

const normalizeSpaces = (value = "") =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeSpanishText = (value = "") =>
  normalizeUnicode(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const suspiciousPayloadPatterns = [
  /--/,
  /;\s*$/,
  /\b(drop|select|insert|update|delete|union|truncate)\b/i,
  /\btable\b/i,
  /<\/?[a-z][^>]*>/i,
  /\{\{.*\}\}/,
  /\$\{.*\}/,
  /\b(system prompt|ignora instrucciones|actua como)\b/i,
];

const nonNameCommandPatterns = [
  /\b(reservar|reserva|turno|cancha|hora|disponibilidad|cancelar|confirmar|admin)\b/i,
  /\b(hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/i,
  /\b(como|que|quien|donde|cuando|cuanto|cual|por que)\b/i,
  /\b(contame|decime|dime|mostrame|explicame|ayudame|necesito|quiero saber|decis|sabes)\b/i,
];

const TOKEN_REGEX = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:[\-'][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)*$/;
const ALLOWED_CONNECTORS = new Set(["de", "del", "la", "las", "los", "da", "do", "di", "y"]);

const hasDigits = (value = "") => /\d/.test(String(value || ""));

const tokenizeName = (value = "") =>
  normalizeSpaces(value)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean);

const isValidNameToken = (token = "") => {
  if (!token) return false;
  const lower = normalizeSpanishText(token);
  if (ALLOWED_CONNECTORS.has(lower)) return true;
  return TOKEN_REGEX.test(token);
};

const hasAtLeastTwoPrincipalTokens = (tokens = []) => {
  const principal = (tokens || []).filter((t) => !ALLOWED_CONNECTORS.has(normalizeSpanishText(t)));
  return principal.length >= 2;
};

const smartTitleCase = (token = "") => {
  const parts = String(token || "").split(/([\-'])/);
  return parts
    .map((part) => {
      if (part === "-" || part === "'") return part;
      if (!part) return "";
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");
};

const formatName = (tokens = []) =>
  tokens
    .map((token) => {
      const lower = normalizeSpanishText(token);
      if (ALLOWED_CONNECTORS.has(lower)) return lower;
      return smartTitleCase(token);
    })
    .join(" ");

const cleanCandidate = (value = “”) =>
  normalizeSpaces(
    String(value || “”)
      .replace(/[“””`´]/g, “”)
      .replace(/[()\[\]{}<>]/g, “ “)
      .replace(/[!?.,:*#@+&|]/g, “ “),
  );

const extractCandidate = (text = "") => {
  const raw = normalizeSpaces(text);
  if (!raw) return "";

  const explicitMatchers = [
    /(?:^|\b)(?:mi\s+nombre\s+es|soy|me\s+llamo)\s*[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ]*\s*([A-Za-zÁÉÍÓÚÜÑáéíóúüñ].+)$/i,
    /^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ\-\s']+)$/,
  ];

  for (const matcher of explicitMatchers) {
    const match = raw.match(matcher);
    if (match?.[1]) {
      return normalizeSpaces(match[1]);
    }
  }

  return raw;
};

const validateCandidate = ({ rawText = "", candidate = "" }) => {
  const raw = String(rawText || "");
  const clean = cleanCandidate(candidate);
  if (!clean) return { ok: false, reason: "empty" };

  if (hasDigits(clean)) return { ok: false, reason: "contains_digits" };
  if (suspiciousPayloadPatterns.some((pattern) => pattern.test(raw))) {
    return { ok: false, reason: "suspicious_payload" };
  }

  const normalizedClean = normalizeSpanishText(clean);
  if (nonNameCommandPatterns.some((pattern) => pattern.test(normalizedClean))) {
    return { ok: false, reason: "mixed_with_commands" };
  }

  const tokens = tokenizeName(clean);
  if (!tokens.length) return { ok: false, reason: "empty" };
  if (!tokens.every(isValidNameToken)) return { ok: false, reason: "invalid_tokens" };
  if (!hasAtLeastTwoPrincipalTokens(tokens)) {
    return { ok: false, reason: "missing_last_name" };
  }

  const firstLower = normalizeSpanishText(tokens[0]);
  const lastLower = normalizeSpanishText(tokens[tokens.length - 1]);
  if (ALLOWED_CONNECTORS.has(firstLower) || ALLOWED_CONNECTORS.has(lastLower)) {
    return { ok: false, reason: "bad_connectors" };
  }

  return {
    ok: true,
    value: formatName(tokens),
    tokens,
  };
};

const extractPersonName = (text = "") => {
  const rawText = normalizeUnicode(text);
  const candidate = extractCandidate(rawText);
  const validation = validateCandidate({ rawText, candidate });
  if (!validation.ok) {
    return {
      isValid: false,
      value: null,
      reason: validation.reason,
      candidate,
    };
  }

  return {
    isValid: true,
    value: validation.value,
    reason: "ok",
    candidate,
    tokens: validation.tokens,
  };
};

module.exports = {
  extractPersonName,
  normalizeSpanishText,
};

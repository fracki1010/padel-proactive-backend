/**
 * Elimina URLs de un texto antes de procesarlo.
 * Útil para que mensajes como "mi nombre es Juan Perez http://test.local"
 * no fallen al extraer el nombre por culpa de la URL adjunta.
 */
const URL_PATTERN =
  /(?:https?:\/\/|www\.)[^\s]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?/gi;

const stripUrlsFromText = (text = "") =>
  String(text || "")
    .replace(URL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

module.exports = { stripUrlsFromText };

/**
 * Mapeo de caracteres homoglyphs (cirílicos y similares) a su equivalente latino.
 * Permite que comandos como "CONFIRMAR RESERVA" escritos con caracteres cirílicos
 * sean reconocidos correctamente por el bot.
 */
const HOMOGLYPH_MAP = {
  // Cirílico → Latino
  "\u0410": "A", // А → A
  "\u0430": "a", // а → a
  "\u0412": "B", // В → B
  "\u0421": "C", // С → C
  "\u0441": "c", // с → c
  "\u0415": "E", // Е → E
  "\u0435": "e", // е → e
  "\u041E": "O", // О → O
  "\u043E": "o", // о → o
  "\u0420": "P", // Р → P
  "\u0440": "p", // р → p
  "\u0422": "T", // Т → T
  "\u0445": "x", // х → x
  "\u0425": "X", // Х → X
  "\u041A": "K", // К → K
  "\u043A": "k", // к → k
  "\u041C": "M", // М → M
  "\u043C": "m", // м → m
  "\u041D": "H", // Н → H
  "\u0443": "y", // у → y
  "\u0418": "I", // И (aproximado)
  // Griego similar
  "\u03BF": "o", // ο griego
  "\u0391": "A", // Α griego
  // Otros visualmente similares
  "\u00D8": "O", // Ø
  "\u00F8": "o", // ø
};

const normalizeHomoglyphs = (text = "") =>
  String(text || "")
    .split("")
    .map((char) => HOMOGLYPH_MAP[char] ?? char)
    .join("");

module.exports = { normalizeHomoglyphs };

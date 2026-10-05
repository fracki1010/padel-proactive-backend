'use strict';

// Guardas de salida para el JSON de decisión de la IA.
//
// P0 (fuga de JSON crudo a WhatsApp): cuando la IA devuelve JSON truncado o
// malformado (max_tokens corto, salida free-form sin response_format), el bot
// no debe filtrar el payload interno como mensaje de WhatsApp. Este módulo
// centraliza el parseo endurecido (fences de markdown + extracción balanceada
// + centinela) y la detección de "esto parece JSON crudo".

const UNPARSEABLE_SENTINEL = Object.freeze({ __unparseable: true });

const stripMarkdownFences = (value = '') =>
  String(value)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

// ¿El texto empieza con un objeto/array JSON (ignorando espacios)?
const startsWithJsonObject = (value = '') => /^\s*[\[{]/.test(String(value || ''));

// ¿El texto parece un payload JSON crudo? Cubre:
//  - arranque con { o [ (payload directo, truncado o malformado)
//  - presencia de claves JSON típicas ("action" o "message") en medio de texto libre
const looksLikeJsonPayload = (value = '') => {
  const text = String(value || '');
  if (startsWithJsonObject(text)) return true;
  return /"(action|message)"\s*:/.test(text);
};

// Extrae el primer bloque balanceado { ... } o [ ... ] desde el primer
// delimitador, respetando strings (para no cortar por llaves dentro de
// valores). Devuelve null si no hay bloque balanceado.
const findBalancedJson = (text) => {
  const startMatch = text.search(/[\[{]/);
  if (startMatch === -1) return null;
  const open = text[startMatch];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startMatch; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(startMatch, i + 1);
    }
  }
  return null;
};

// Parseo endurecido del JSON de decisión del modelo:
//   1. parseo directo
//   2. parseo tras quitar fences de markdown
//   3. extracción balanceada de llaves/corchetes en texto libre
//   4. si arranca con { o [ pero no parsea (truncado/malformado) → centinela
//      {__unparseable:true} para que el caller NUNCA lo trate como texto plano
//   5. texto plano → null
const extractJSON = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // noop: seguir con fences / extracción balanceada
  }

  const fenced = stripMarkdownFences(trimmed);
  try {
    return JSON.parse(fenced);
  } catch (e) {
    // noop
  }

  const balanced = findBalancedJson(fenced);
  if (balanced !== null) {
    try {
      return JSON.parse(balanced);
    } catch (e) {
      // noop
    }
  }

  if (startsWithJsonObject(trimmed)) return UNPARSEABLE_SENTINEL;
  return null;
};

module.exports = {
  extractJSON,
  looksLikeJsonPayload,
  startsWithJsonObject,
  stripMarkdownFences,
  UNPARSEABLE_SENTINEL,
};
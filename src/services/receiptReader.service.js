'use strict';

// Transfer-receipt reader: turns an incoming WhatsApp payment receipt (image or
// PDF) into a STRUCTURED receipt and validates it against a pending transfer
// seña. The bot uses it to auto-confirm a `pendiente_seña` booking.
//
// Design notes:
// - Every external dependency (Groq vision/text, pdf-parse, pdfjs-dist) is
//   INJECTABLE via the `deps` argument so the logic is testable without network
//   or native libs. Defaults are lazily required so importing this module never
//   boots a Groq client nor exits when no API key is configured.
// - `normalizeBank` and `validateReceipt` are pure.
// - The amount comparison is EXACT (no tolerance): the receipt must prove the
//   configured seña was transferred, nothing less and nothing more.

const BANK_ALIASES = new Map([
  ['naranja x', 'naranja-x'],
  ['naranjax', 'naranja-x'],
  ['naranja', 'naranja-x'],
  ['mercado pago', 'mercado-pago'],
  ['mercadopago', 'mercado-pago'],
  ['mp', 'mercado-pago'],
  ['bna', 'bna'],
  ['banco nacion', 'bna'],
  ['banco de la nacion', 'bna'],
  ['banco nación', 'bna'],
  ['banco de la nación', 'bna'],
  ['bbva', 'bbva'],
  ['banco bbva', 'bbva'],
  ['santander', 'santander'],
  ['banco santander', 'santander'],
  ['banco santander rio', 'santander'],
  ['banco santander río', 'santander'],
  ['supervielle', 'supervielle'],
  ['banco supervielle', 'supervielle'],
]);

const SUPPORTED_BANKS = [
  'naranja-x',
  'mercado-pago',
  'bna',
  'bbva',
  'santander',
  'supervielle',
];

// Keywords that hint a PDF already carries extractable text (bank/transfer
// vocabulary or an amount). Only used to decide text vs. scanned rendering.
const TEXT_HINTS = [
  'naranja',
  'mercado pago',
  'mercadopago',
  'bna',
  'banco',
  'bbva',
  'santander',
  'supervielle',
  'transferencia',
  'transf',
  'cbu',
  'alias',
  'cuit',
  'cuil',
];

const receiptPrompt = () =>
  [
    'Sos un extractor de datos de comprobantes de transferencia bancaria argentinos.',
    'Devolvé EXCLUSIVAMENTE un JSON válido, sin texto extra, con esta forma:',
    '{"bank": string, "amount": number, "amountPaid": number, "date": "YYYY-MM-DD", "time": "HH:mm", "cuit": string, "text": string}',
    'Reglas:',
    '- "bank" debe ser uno de: Naranja X, Mercado Pago, BNA, BBVA, Santander, Supervielle (tal cual).',
    '- "amountPaid" es el importe efectivamente transferido, numérico sin separadores.',
    '- "amount" es el importe total del comprobante si aparece.',
    '- "date"/"time" en formato YYYY-MM-DD y HH:mm (hora local de Argentina).',
    '- "cuit" del destinatario/origen si aparece; si no, null.',
    '- "text" es un fragmento crudo del texto visible del comprobante.',
    'Si no podés leerlo, devolvé {"bank": null, "amountPaid": null, "date": null, "time": null}.',
  ].join('\n');

const resolveMediaKind = (mimetype, filename) => {
  const mime = String(mimetype || '').trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  const name = String(filename || '').trim().toLowerCase();
  if (name.endsWith('.pdf')) return 'pdf';
  return null;
};

const normalizeTextKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

// Canonical bank key for one of the six supported banks, or null. Accepts
// aliases, casing and accents. Also tries a loose containment match so a model
// reply like "Banco Santander S.A." still resolves.
const normalizeBank = (name) => {
  const key = normalizeTextKey(name)
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!key) return null;
  if (BANK_ALIASES.has(key)) return BANK_ALIASES.get(key);

  // Loose containment, longest aliases first, on word boundaries only. Short
  // aliases ("mp") are excluded to avoid matching unrelated words.
  const aliases = [...BANK_ALIASES.keys()]
    .filter((alias) => alias.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|\\s)${escaped}($|\\s)`).test(key)) {
      return BANK_ALIASES.get(alias);
    }
  }
  return null;
};

// Parses a currency string ("$ 5.000,00", "12.500", 5000) into a Number.
// Returns null when it cannot resolve a finite number.
const parseAmountValue = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.,-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === ',') return null;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');
  let normalized = cleaned;

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = cleaned.split(',');
    normalized =
      parts.length === 2 && parts[1].length > 0 && parts[1].length <= 2
        ? `${parts[0]}.${parts[1]}`
        : cleaned.replace(/,/g, '');
  } else if (hasDot) {
    const parts = cleaned.split('.');
    normalized =
      parts.length === 2 && parts[1].length > 0 && parts[1].length <= 2
        ? cleaned
        : cleaned.replace(/\./g, '');
  }

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
};

// Defensive JSON extraction: strips markdown fences and surrounding prose, then
// parses the first complete object. Returns null on any failure.
const parseModelJson = (raw) => {
  let text = String(raw || '').trim();
  if (!text) return null;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeParsed = (raw, textSnippet = '') => {
  if (!raw || typeof raw !== 'object') return null;
  return {
    bank: raw.bank ?? raw.banco ?? null,
    amount: raw.amount ?? raw.monto ?? null,
    amountPaid: raw.amountPaid ?? raw.montoPagado ?? raw.paidAmount ?? raw.amount ?? raw.monto ?? null,
    date: raw.date ?? raw.fecha ?? null,
    time: raw.time ?? raw.hora ?? null,
    cuit: raw.cuit ?? raw.cuil ?? null,
    text: String(raw.text || raw.rawText || textSnippet || ''),
  };
};

const buildDataUrl = (buffer, mimetype) => {
  const mime = String(mimetype || 'image/jpeg').trim() || 'image/jpeg';
  const base64 =
    Buffer.isBuffer(buffer) ? buffer.toString('base64') : Buffer.from(String(buffer || '')).toString('base64');
  return `data:${mime};base64,${base64}`;
};

const firstGroqKey = () => {
  const multi = String(process.env.GROQ_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (multi.length) return multi[0];
  return String(process.env.GROQ_API_KEY || '').trim() || null;
};

const defaultCallGroq = async (messages, { maxTokens = 512, vision = false } = {}) => {
  const apiKey = firstGroqKey();
  if (!apiKey) throw new Error('GROQ_API_KEY no configurada para leer comprobantes.');
  const Groq = require('groq-sdk');
  const client = new Groq({ apiKey });
  const model = vision
    ? process.env.GROQ_VISION_MODEL || 'llama-3.2-90b-vision-preview'
    : process.env.GROQ_RECEIPT_MODEL || process.env.GROQ_MODEL_PRIMARY || 'openai/gpt-oss-120b';
  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: maxTokens,
    messages,
  });
  return completion.choices[0]?.message?.content || '';
};

const defaultCallVision = ({ dataUrl, prompt }) =>
  defaultCallGroq(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    { vision: true },
  );

const defaultCallText = ({ text, prompt }) =>
  defaultCallGroq([{ role: 'user', content: `${prompt}\n\nTexto del comprobante:\n${text}` }], {
    vision: false,
  });

const defaultPdfParse = async (buffer) => {
  const pdfParse = require('pdf-parse');
  const result = await pdfParse(buffer);
  return typeof result === 'string' ? { text: result } : result || { text: '' };
};

const defaultPdfToImages = async (buffer) => {
  // pdfjs-dist v3 legacy CommonJS build (the backend is CommonJS). Rendering in
  // Node needs DOM shims which @napi-rs/canvas provides.
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const canvasModule = require('@napi-rs/canvas');
  for (const name of ['DOMMatrix', 'Path2D', 'ImageData']) {
    if (!globalThis[name] && canvasModule[name]) globalThis[name] = canvasModule[name];
  }

  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({
    data,
    disableWorker: true,
    isEvalSupported: false,
  }).promise;
  const pages = [];
  const pageCount = Math.min(doc.numPages, 2);
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = canvasModule.createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    const context = canvas.getContext('2d');
    await page.render({ canvasContext: context, viewport }).promise;
    pages.push(`data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`);
  }
  return pages;
};

const isSubstantiveText = (text) => {
  const clean = normalizeTextKey(text);
  if (clean.length < 12) return false;
  if (TEXT_HINTS.some((hint) => clean.includes(hint))) return true;
  return /(?:ars|\$)\s?\d/.test(clean) || /\b\d{3,}(?:[.,]\d{2})?\b/.test(clean);
};

const parseReceipt = async ({ buffer, mimetype, filename } = {}, deps = {}) => {
  const callVision = deps.callVision || defaultCallVision;
  const callText = deps.callText || defaultCallText;
  const kind = resolveMediaKind(mimetype, filename);
  if (!kind) return null;

  if (kind === 'image') {
    const raw = await callVision({ dataUrl: buildDataUrl(buffer, mimetype), prompt: receiptPrompt() });
    return normalizeParsed(parseModelJson(raw));
  }

  // PDF: prefer embedded text; only render to image when the PDF is scanned.
  const pdfParse = deps.pdfParse || defaultPdfParse;
  let text = '';
  try {
    const parsedPdf = await pdfParse(buffer);
    text = String((parsedPdf && parsedPdf.text) || parsedPdf || '');
  } catch {
    text = '';
  }

  if (isSubstantiveText(text)) {
    const raw = await callText({ text, prompt: receiptPrompt() });
    return normalizeParsed(parseModelJson(raw), text);
  }

  const pdfToImages = deps.pdfToImages || defaultPdfToImages;
  const pages = (await pdfToImages(buffer)) || [];
  const firstPage = pages.find(Boolean);
  if (!firstPage) return null;
  const raw = await callVision({ dataUrl: firstPage, prompt: receiptPrompt() });
  return normalizeParsed(parseModelJson(raw), text);
};

const parseReceiptEpoch = ({ date, time }, timezoneOffsetMinutes) => {
  const dateMatch = String(date || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(time || '').trim().match(/^(\d{1,2}):(\d{2})/);
  if (!dateMatch || !timeMatch) return NaN;
  const utcMs = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    0,
    0,
  );
  return utcMs - Number(timezoneOffsetMinutes) * 60 * 1000;
};

// Validates a parsed receipt against the booking. Exact amount, bank in the
// supported list, and a receipt time within `maxDeltaMinutes` (default 15) of
// the moment the turn request was created. Returns `{ valid, reasons, bank }`;
// `reasons` is a friendly Spanish list of every failing check.
const validateReceipt = (
  parsed,
  { expectedAmount, bookingCreatedAt, timezoneOffsetMinutes = -180, maxDeltaMinutes = 15 } = {},
) => {
  const reasons = [];
  const receipt = parsed || {};

  const expected = parseAmountValue(expectedAmount);
  const received = parseAmountValue(receipt.amountPaid ?? receipt.amount);
  if (received === null) {
    reasons.push('no se pudo leer el monto');
  } else if (expected === null || received !== expected) {
    reasons.push('el monto no coincide');
  }

  const receiptEpoch = parseReceiptEpoch(receipt, timezoneOffsetMinutes);
  const bookingEpoch =
    bookingCreatedAt instanceof Date
      ? bookingCreatedAt.getTime()
      : new Date(bookingCreatedAt).getTime();
  if (!Number.isFinite(receiptEpoch) || !Number.isFinite(bookingEpoch)) {
    reasons.push('no se pudo leer la fecha y hora');
  } else if (Math.abs(receiptEpoch - bookingEpoch) > maxDeltaMinutes * 60 * 1000) {
    reasons.push('la hora está fuera de los 15 minutos');
  }

  const bank = normalizeBank(receipt.bank);
  if (!bank) {
    reasons.push('el banco no está en la lista');
  }

  return { valid: reasons.length === 0, reasons, bank };
};

module.exports = {
  BANK_ALIASES,
  SUPPORTED_BANKS,
  normalizeBank,
  validateReceipt,
  parseReceipt,
  parseModelJson,
  parseAmountValue,
  resolveMediaKind,
};

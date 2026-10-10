'use strict';

// Strict TDD suite for the transfer-receipt reader.
//
// `receiptReader.service` is the pure/near-pure core of bot receipt verification:
// it turns an image or PDF into a structured receipt (via an INJECTED model
// call) and validates it against the booking's expected seña amount and the
// 15-minute window around the booking creation. No network: every model/PDF
// dependency is replaced with a deterministic stub.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'gsk_test_dummy_key';

const {
  normalizeBank,
  validateReceipt,
  parseReceipt,
  parseModelJson,
  parseAmountValue,
  resolveMediaKind,
} = require('../services/receiptReader.service');

// ── normalizeBank ───────────────────────────────────────────────────────────

test('normalizeBank canonicalizes the six supported banks', () => {
  assert.equal(normalizeBank('Naranja X'), 'naranja-x');
  assert.equal(normalizeBank('Mercado Pago'), 'mercado-pago');
  assert.equal(normalizeBank('BNA'), 'bna');
  assert.equal(normalizeBank('BBVA'), 'bbva');
  assert.equal(normalizeBank('Santander'), 'santander');
  assert.equal(normalizeBank('Supervielle'), 'supervielle');
});

test('normalizeBank accepts common aliases and casing/accents', () => {
  assert.equal(normalizeBank('NARANJA X'), 'naranja-x');
  assert.equal(normalizeBank('NaranjaX'), 'naranja-x');
  assert.equal(normalizeBank('MercadoPago'), 'mercado-pago');
  assert.equal(normalizeBank('Banco Nación'), 'bna');
  assert.equal(normalizeBank('Banco de la Nacion'), 'bna');
  assert.equal(normalizeBank('Banco Santander Rio'), 'santander');
  assert.equal(normalizeBank('Banco Supervielle S.A.'), 'supervielle');
});

test('normalizeBank returns null for unknown/empty banks', () => {
  assert.equal(normalizeBank('Banco Galicia'), null);
  assert.equal(normalizeBank(''), null);
  assert.equal(normalizeBank(null), null);
  assert.equal(normalizeBank(undefined), null);
});

// ── parseAmountValue ────────────────────────────────────────────────────────

test('parseAmountValue normalizes currency separators to a number', () => {
  assert.equal(parseAmountValue('5.000,00'), 5000);
  assert.equal(parseAmountValue('$ 5.000,00'), 5000);
  assert.equal(parseAmountValue('5000'), 5000);
  assert.equal(parseAmountValue(5000), 5000);
  assert.equal(parseAmountValue('12.500'), 12500);
  assert.equal(parseAmountValue('not-a-number'), null);
  assert.equal(parseAmountValue(''), null);
});

// ── resolveMediaKind ────────────────────────────────────────────────────────

test('resolveMediaKind detects image and pdf media', () => {
  assert.equal(resolveMediaKind('image/jpeg', 'foto.jpg'), 'image');
  assert.equal(resolveMediaKind('image/png', undefined), 'image');
  assert.equal(resolveMediaKind('application/pdf', 'comp.pdf'), 'pdf');
  assert.equal(resolveMediaKind(undefined, 'comprobante.PDF'), 'pdf');
  assert.equal(resolveMediaKind('text/plain', 'notas.txt'), null);
});

// ── parseModelJson (defensive) ──────────────────────────────────────────────

test('parseModelJson strips markdown fences and leading prose', () => {
  const fenced = '```json\n{"bank":"Naranja X","amountPaid":5000}\n```';
  assert.deepEqual(parseModelJson(fenced), { bank: 'Naranja X', amountPaid: 5000 });

  const prose = 'Claro, aquí está:\n{"bank":"BBVA","amountPaid":1000}.';
  assert.deepEqual(parseModelJson(prose), { bank: 'BBVA', amountPaid: 1000 });

  assert.equal(parseModelJson('no hay json aca'), null);
  assert.equal(parseModelJson(''), null);
});

// ── validateReceipt ─────────────────────────────────────────────────────────

const BOOKING_AT = new Date('2026-04-07T23:15:00.000Z'); // 20:15 ART (UTC-3)

test('validateReceipt accepts an exact amount at the booking minute', () => {
  const result = validateReceipt(
    { bank: 'Naranja X', amountPaid: 5000, date: '2026-04-07', time: '20:15' },
    { expectedAmount: 5000, bookingCreatedAt: BOOKING_AT },
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.reasons, []);
});

test('validateReceipt accepts a receipt 15 minutes away (window boundary)', () => {
  const result = validateReceipt(
    { bank: 'Mercado Pago', amountPaid: 5000, date: '2026-04-07', time: '20:30' },
    { expectedAmount: 5000, bookingCreatedAt: BOOKING_AT },
  );
  assert.equal(result.valid, true);
  assert.deepEqual(result.reasons, []);
});

test('validateReceipt rejects an amount that does not match exactly', () => {
  const result = validateReceipt(
    { bank: 'Naranja X', amountPaid: 4999, date: '2026-04-07', time: '20:15' },
    { expectedAmount: 5000, bookingCreatedAt: BOOKING_AT },
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('el monto no coincide'));
});

test('validateReceipt accepts a formatted amount that equals the expected one', () => {
  const result = validateReceipt(
    { bank: 'Naranja X', amountPaid: '5.000,00', date: '2026-04-07', time: '20:15' },
    { expectedAmount: 5000, bookingCreatedAt: BOOKING_AT },
  );
  assert.equal(result.valid, true);
});

test('validateReceipt rejects a receipt outside the 15-minute window', () => {
  const result = validateReceipt(
    { bank: 'Naranja X', amountPaid: 5000, date: '2026-04-07', time: '20:31' },
    { expectedAmount: 5000, bookingCreatedAt: BOOKING_AT },
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('la hora está fuera de los 15 minutos'));
});

test('validateReceipt rejects an unknown bank', () => {
  const result = validateReceipt(
    { bank: 'Banco Galicia', amountPaid: 5000, date: '2026-04-07', time: '20:15' },
    { expectedAmount: 5000, bookingCreatedAt: BOOKING_AT },
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('el banco no está en la lista'));
});

test('validateReceipt reports unreadable date/time', () => {
  const result = validateReceipt(
    { bank: 'BBVA', amountPaid: 5000, date: null, time: null },
    { expectedAmount: 5000, bookingCreatedAt: BOOKING_AT },
  );
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes('no se pudo leer la fecha y hora'));
});

// ── parseReceipt: image via injected vision ─────────────────────────────────

const imageMedia = () => ({
  buffer: Buffer.from('fake-image-bytes'),
  mimetype: 'image/jpeg',
  filename: 'comprobante.jpg',
});

test('parseReceipt reads an image through the injected vision call', async () => {
  let seenDataUrl = '';
  const parsed = await parseReceipt(imageMedia(), {
    callVision: async ({ dataUrl }) => {
      seenDataUrl = dataUrl;
      return '```json\n{"bank":"Naranja X","amountPaid":5000,"date":"2026-04-07","time":"20:15","cuit":"20-12345678-9","text":"TRANSF NARANJA X"}\n```';
    },
  });

  assert.ok(seenDataUrl.startsWith('data:image/jpeg;base64,'), 'vision gets a data URL');
  assert.equal(parsed.bank, 'Naranja X');
  assert.equal(parsed.amountPaid, 5000);
  assert.equal(parsed.date, '2026-04-07');
  assert.equal(parsed.time, '20:15');
  assert.equal(parsed.cuit, '20-12345678-9');
});

test('parseReceipt returns null when the image model emits no JSON', async () => {
  const parsed = await parseReceipt(imageMedia(), {
    callVision: async () => 'no pude leer la imagen',
  });
  assert.equal(parsed, null);
});

// ── parseReceipt: PDF text path ─────────────────────────────────────────────

test('parseReceipt extracts a text-based PDF without vision', async () => {
  let textPrompt = '';
  let visionCalled = false;
  const parsed = await parseReceipt(
    { buffer: Buffer.from('%PDF-fake'), mimetype: 'application/pdf', filename: 'comp.pdf' },
    {
      pdfParse: async () => ({
        text: 'TRANSFERENCIA Naranja X\nImporte: $5.000,00\nFecha 07/04/2026 20:15',
      }),
      callText: async ({ text }) => {
        textPrompt = text;
        return '{"bank":"Naranja X","amountPaid":"5.000,00","date":"2026-04-07","time":"20:15"}';
      },
      callVision: async () => {
        visionCalled = true;
        return '{}';
      },
    },
  );

  assert.ok(textPrompt.includes('Naranja X'), 'the text prompt carries the extracted text');
  assert.equal(visionCalled, false, 'text PDFs must not fall back to vision');
  assert.equal(parsed.amountPaid, '5.000,00');
  assert.equal(parsed.bank, 'Naranja X');
});

test('parseReceipt renders a scanned PDF to an image and runs vision', async () => {
  let rendered = false;
  const parsed = await parseReceipt(
    { buffer: Buffer.from('%PDF-scanned'), mimetype: 'application/pdf', filename: 'scan.pdf' },
    {
      pdfParse: async () => ({ text: '' }),
      pdfToImages: async () => {
        rendered = true;
        return ['data:image/png;base64,AAAA'];
      },
      callVision: async ({ dataUrl }) => {
        assert.equal(dataUrl, 'data:image/png;base64,AAAA');
        return '{"bank":"BNA","amountPaid":5000,"date":"2026-04-07","time":"20:15"}';
      },
    },
  );

  assert.equal(rendered, true, 'a scanned PDF must be rendered to an image');
  assert.equal(parsed.bank, 'BNA');
  assert.equal(parsed.amountPaid, 5000);
});

test('parseReceipt returns null for an unsupported media type', async () => {
  const parsed = await parseReceipt(
    { buffer: Buffer.from('x'), mimetype: 'text/plain', filename: 'notas.txt' },
    { callVision: async () => ({}) },
  );
  assert.equal(parsed, null);
});

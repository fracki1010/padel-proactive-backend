'use strict';

// Route contract for the media branch of POST /internal/whatsapp/incoming:
// a media-only payload (empty body) must be accepted, decoded to a Buffer, and
// routed to the receipt-verification handler; the reply is enqueued as a
// WhatsApp SEND_MESSAGE. Text-only and truly-empty payloads keep their behavior.

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'gsk_test_dummy_key';
process.env.BACKEND_INTERNAL_TOKEN = 'test-internal-token';

const COMPANY = '64b0000000000000000000a1';

const receiptVerification = require('../services/receiptVerification.service');
const whatsappQueue = require('../services/whatsappCommandQueue.service');

let lastReceiptCall = null;
let enqueued = [];
receiptVerification.handleIncomingReceipt = async (args) => {
  lastReceiptCall = args;
  return { handled: true, confirmed: true, reply: '✅ *Seña verificada.* ¡Tu turno quedó confirmado! 🎾', reasons: [] };
};
whatsappQueue.enqueueWhatsappCommand = async (args) => {
  enqueued.push(args);
  return { command: { _id: 'cmd-receipt-1' } };
};

const router = require('../routes/internal.routes');

const getIncomingHandler = () => {
  const layer = router.stack.find(
    (entry) => entry.route && entry.route.path === '/whatsapp/incoming',
  );
  return layer.route.stack[0].handle;
};

const createResponse = () => {
  const captured = {};
  return {
    captured,
    status(code) {
      captured.statusCode = code;
      return this;
    },
    json(body) {
      captured.body = body;
      return this;
    },
  };
};

const createReq = (body) => ({
  headers: { 'x-internal-token': 'test-internal-token' },
  body,
});

test('a media-only payload is accepted and routed to receipt verification', async () => {
  lastReceiptCall = null;
  enqueued = [];
  const res = createResponse();

  await getIncomingHandler()(
    createReq({
      companyId: COMPANY,
      from: '5491100000000@c.us',
      body: '',
      media: { mimetype: 'image/jpeg', filename: 'c.jpg', data: Buffer.from('bytes').toString('base64') },
    }),
    res,
  );

  assert.equal(res.captured.statusCode, 202);
  assert.equal(res.captured.body.data.enqueued, true);
  assert.equal(res.captured.body.data.confirmed, true);
  assert.ok(lastReceiptCall, 'receipt verification must be invoked');
  assert.ok(Buffer.isBuffer(lastReceiptCall.media.buffer), 'media.data must be decoded to a Buffer');
  assert.equal(lastReceiptCall.media.mimetype, 'image/jpeg');
  assert.equal(enqueued.length, 1, 'the confirmation reply must be enqueued');
  assert.equal(enqueued[0].payload.to, '5491100000000@c.us');
});

test('an empty payload with no body and no media is rejected with 400', async () => {
  lastReceiptCall = null;
  const res = createResponse();

  await getIncomingHandler()(
    createReq({ companyId: COMPANY, from: '5491100000000@c.us', body: '' }),
    res,
  );

  assert.equal(res.captured.statusCode, 400);
  assert.equal(lastReceiptCall, null, 'receipt verification must not run without media');
});

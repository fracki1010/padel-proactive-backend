'use strict';

// Unit tests for the WhatsApp-only client auth domain service.
// The service is deliberately model-injected so the orchestration can be
// exercised without a live MongoDB connection.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canonicalizePhone,
  buildNormalizedPhone,
  decidePhoneLogin,
  planGoogleAuth,
  verifyOtpCode,
  resolveClientByVerifiedPhone,
  completeRegistration,
} = require('../services/clientAuth.service');

// ── In-memory fakes ─────────────────────────────────────────────────────────
const makeFakeModels = ({ clientAccount = null, user = null } = {}) => {
  const created = { clients: [], users: [] };

  const ClientAccount = {
    findOne: async () => clientAccount,
    create: async (doc) => {
      const record = { ...doc, _id: `client-${created.clients.length + 1}` };
      record.save = async () => record;
      created.clients.push(record);
      return record;
    },
  };

  const User = {
    findOne: async () => user,
    create: async (doc) => {
      const record = { ...doc, _id: `user-${created.users.length + 1}` };
      created.users.push(record);
      return record;
    },
  };

  return { ClientAccount, User, created };
};

// ── Pure helpers ────────────────────────────────────────────────────────────

test('buildNormalizedPhone agrega el 9 argentino cuando falta', () => {
  assert.equal(buildNormalizedPhone('54', '2622517447'), '5492622517447');
  assert.equal(buildNormalizedPhone('54', '92622517447'), '5492622517447');
  assert.equal(buildNormalizedPhone('598', '91234567'), '59891234567');
});

test('canonicalizePhone no duplica el 9 y respeta números cortos', () => {
  assert.equal(canonicalizePhone('5492622517447'), '5492622517447');
  assert.equal(canonicalizePhone('542622517447'), '5492622517447');
  assert.equal(canonicalizePhone('123'), '123');
});

test('decidePhoneLogin prioriza ClientAccount y cae a User', () => {
  assert.deepEqual(decidePhoneLogin({ hasClientAccount: true, hasUser: true }), { action: 'login' });
  assert.deepEqual(decidePhoneLogin({ hasClientAccount: false, hasUser: true }), {
    action: 'login',
    linkUser: true,
  });
  assert.deepEqual(decidePhoneLogin({ hasClientAccount: false, hasUser: false }), {
    action: 'needs_name',
  });
});

// ── resolveClientByVerifiedPhone ────────────────────────────────────────────

test('resolveClientByVerifiedPhone: ClientAccount existente entra directo sin crear nada', async () => {
  const client = { _id: 'c-existing', name: 'Ana', phone: '5492622517447', isActive: true };
  const models = makeFakeModels({ clientAccount: client });

  const result = await resolveClientByVerifiedPhone({
    companyId: 'co1',
    phone: '5492622517447',
    models,
  });

  assert.equal(result.kind, 'login');
  assert.equal(result.client, client);
  assert.equal(models.created.clients.length, 0);
  assert.equal(models.created.users.length, 0);
});

test('resolveClientByVerifiedPhone: User sin ClientAccount crea la cuenta con el nombre del User', async () => {
  const user = { _id: 'u-bruno', name: 'Bruno Díaz', phoneNumber: '5492622517447' };
  const models = makeFakeModels({ user });

  const result = await resolveClientByVerifiedPhone({
    companyId: 'co1',
    phone: '5492622517447',
    models,
  });

  assert.equal(result.kind, 'login');
  assert.equal(result.client.name, 'Bruno Díaz');
  assert.equal(result.client.linkedUserId, 'u-bruno');
  assert.equal(result.client.googleAuth, false);
  assert.equal(result.client.passwordHash, '');
  assert.equal(models.created.clients.length, 1);
});

test('resolveClientByVerifiedPhone: número nuevo pide nombre y no crea registros', async () => {
  const models = makeFakeModels({});

  const result = await resolveClientByVerifiedPhone({
    companyId: 'co1',
    phone: '5492622517447',
    models,
  });

  assert.equal(result.kind, 'needs_name');
  assert.equal(result.phone, '5492622517447');
  assert.equal(models.created.clients.length, 0);
  assert.equal(models.created.users.length, 0);
});

// ── completeRegistration ────────────────────────────────────────────────────

test('completeRegistration crea User y ClientAccount vinculados', async () => {
  const models = makeFakeModels({});

  const client = await completeRegistration({
    companyId: 'co1',
    phone: '5492622517447',
    name: '  Carla López  ',
    models,
  });

  assert.equal(models.created.users.length, 1);
  const [user] = models.created.users;
  assert.equal(user.name, 'Carla López');
  assert.equal(user.phoneNumber, '5492622517447');
  assert.equal(user.accountOrigin, 'sistema');
  assert.equal(user.whatsappId, '5492622517447@c.us');

  assert.equal(models.created.clients.length, 1);
  assert.equal(client.name, 'Carla López');
  assert.equal(client.email, '');
  assert.equal(client.passwordHash, '');
  assert.equal(client.googleAuth, false);
  assert.equal(client.linkedUserId, user._id);
});

test('completeRegistration respeta whatsappId y origin cuando se proveen', async () => {
  const models = makeFakeModels({});

  await completeRegistration({
    companyId: 'co1',
    phone: '5492622517447',
    name: 'Diego',
    models,
    whatsappId: '5492622517447@lid',
    origin: 'whatsapp',
  });

  assert.equal(models.created.users[0].whatsappId, '5492622517447@lid');
  assert.equal(models.created.users[0].accountOrigin, 'whatsapp');
});

// ── Google verification plan ────────────────────────────────────────────────

test('planGoogleAuth exige verificación de teléfono con OTP', () => {
  assert.equal(planGoogleAuth({ phoneProvided: false, otpProvided: false }), 'needs_phone');
  assert.equal(planGoogleAuth({ phoneProvided: true, otpProvided: false }), 'needs_otp');
  assert.equal(planGoogleAuth({ phoneProvided: true, otpProvided: true }), 'verify_otp');
});

// ── verifyOtpCode ───────────────────────────────────────────────────────────

test('verifyOtpCode acepta el código correcto', async () => {
  const otpDoc = { code: '123456', used: false };
  const OtpVerification = { findOne: async () => otpDoc };

  const result = await verifyOtpCode({
    companyId: 'co1',
    phone: '5492622517447',
    code: '123456',
    OtpVerification,
  });

  assert.equal(result.valid, true);
  assert.equal(result.otp, otpDoc);
});

test('verifyOtpCode rechaza código incorrecto y código expirado', async () => {
  const OtpVerification = { findOne: async () => ({ code: '123456', used: false }) };

  const wrong = await verifyOtpCode({
    companyId: 'co1',
    phone: '5492622517447',
    code: '000000',
    OtpVerification,
  });
  assert.equal(wrong.valid, false);
  assert.equal(wrong.reason, 'Código incorrecto');

  const expired = await verifyOtpCode({
    companyId: 'co1',
    phone: '5492622517447',
    code: '123456',
    OtpVerification: { findOne: async () => null },
  });
  assert.equal(expired.valid, false);
  assert.equal(expired.reason, 'Código inválido o expirado');
});

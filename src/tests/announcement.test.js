'use strict';

// Unit tests for the club announcements domain.
// The vigencia filter is a pure query builder and the payload validation is a
// pure function, so both can be exercised without a live MongoDB connection.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-announcements';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  ANNOUNCEMENT_TYPES,
  buildActiveAnnouncementsQuery,
  validateAnnouncementInput,
} = require('../services/announcement.service');
const { tenantFilter } = require('../middleware/auth.middleware');

// ── Minimal Mongo matcher ────────────────────────────────────────────────────
// Interprets the operator subset produced by buildActiveAnnouncementsQuery so
// the tests assert the REAL query behavior against concrete documents.
const matchesQuery = (doc, query) => {
  for (const [key, condition] of Object.entries(query)) {
    if (key === '$and') {
      if (!condition.every((sub) => matchesQuery(doc, sub))) return false;
      continue;
    }
    if (key === '$or') {
      if (!condition.some((sub) => matchesQuery(doc, sub))) return false;
      continue;
    }

    const value = doc[key];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('$lte' in condition && !(value instanceof Date && value <= condition.$lte)) return false;
      if ('$gte' in condition && !(value instanceof Date && value >= condition.$gte)) return false;
    } else if (value !== condition) {
      return false;
    }
  }
  return true;
};

const COMPANY_ID = 'company-a';
const NOW = new Date('2026-06-15T12:00:00.000Z');
const baseDoc = { companyId: COMPANY_ID, isActive: true, startsAt: null, endsAt: null };
const isVigente = (overrides = {}) =>
  matchesQuery({ ...baseDoc, ...overrides }, buildActiveAnnouncementsQuery(COMPANY_ID, NOW));

// ── Vigencia filter ──────────────────────────────────────────────────────────

test('buildActiveAnnouncementsQuery scopes by company and active flag', () => {
  const query = buildActiveAnnouncementsQuery(COMPANY_ID, NOW);
  assert.equal(query.companyId, COMPANY_ID);
  assert.equal(query.isActive, true);
});

test('vigencia: aviso activo sin ventana temporal está vigente', () => {
  assert.equal(isVigente(), true);
});

test('vigencia: aviso inactivo no está vigente', () => {
  assert.equal(isVigente({ isActive: false }), false);
});

test('vigencia: aviso que arranca en el futuro no está vigente', () => {
  assert.equal(isVigente({ startsAt: new Date('2026-06-20T00:00:00.000Z') }), false);
});

test('vigencia: aviso que ya arrancó está vigente', () => {
  assert.equal(isVigente({ startsAt: new Date('2026-06-01T00:00:00.000Z') }), true);
});

test('vigencia: aviso vencido (endsAt pasado) no está vigente', () => {
  assert.equal(isVigente({ endsAt: new Date('2026-06-10T00:00:00.000Z') }), false);
});

test('vigencia: aviso con fin futuro está vigente', () => {
  assert.equal(isVigente({ endsAt: new Date('2026-06-30T00:00:00.000Z') }), true);
});

test('vigencia: aviso de otro club no matchea', () => {
  assert.equal(isVigente({ companyId: 'company-b' }), false);
});

// ── Scoping ──────────────────────────────────────────────────────────────────

test('scoping: admin queda restringido a su companyId', () => {
  assert.deepEqual(tenantFilter({ user: { role: 'admin', companyId: 'c1' } }), {
    companyId: 'c1',
  });
});

test('scoping: super_admin no queda restringido por club', () => {
  assert.deepEqual(tenantFilter({ user: { role: 'super_admin' } }), {});
});

test('scoping: admin sin companyId no puede matchear datos ajenos', () => {
  assert.deepEqual(tenantFilter({ user: { role: 'admin' } }), { _id: null });
});

// ── Payload validation (CRUD) ────────────────────────────────────────────────

test('validateAnnouncementInput expone los tipos permitidos', () => {
  assert.deepEqual(ANNOUNCEMENT_TYPES, ['info', 'important', 'promo']);
});

test('validateAnnouncementInput create exige title y message', () => {
  const { data, errors } = validateAnnouncementInput({});
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /title/i.test(e)));
  assert.ok(errors.some((e) => /message/i.test(e)));
  assert.equal(data.title, undefined);
  assert.equal(data.message, undefined);
});

test('validateAnnouncementInput create acepta payload mínimo y deja defaults al modelo', () => {
  const { data, errors } = validateAnnouncementInput({ title: 'Torneo', message: 'Sábado hasta las 18h' });
  assert.deepEqual(errors, []);
  assert.equal(data.title, 'Torneo');
  assert.equal(data.message, 'Sábado hasta las 18h');
  assert.equal(data.type, undefined);
  assert.equal(data.isActive, undefined);
});

test('validateAnnouncementInput trimmea title/message y normaliza campos completos', () => {
  const { data, errors } = validateAnnouncementInput({
    title: '  Promo 2x1  ',
    message: '  Los martes  ',
    type: 'promo',
    isActive: false,
    startsAt: '2026-06-01T00:00:00.000Z',
    endsAt: '2026-06-30T00:00:00.000Z',
    order: 2,
  });
  assert.deepEqual(errors, []);
  assert.equal(data.title, 'Promo 2x1');
  assert.equal(data.message, 'Los martes');
  assert.equal(data.type, 'promo');
  assert.equal(data.isActive, false);
  assert.ok(data.startsAt instanceof Date);
  assert.ok(data.endsAt instanceof Date);
  assert.equal(data.order, 2);
});

test('validateAnnouncementInput rechaza un type fuera del enum', () => {
  const { errors } = validateAnnouncementInput({ title: 'a', message: 'b', type: 'urgent' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /type/i);
});

test('validateAnnouncementInput rechaza isActive no booleano', () => {
  const { errors } = validateAnnouncementInput({ title: 'a', message: 'b', isActive: 'si' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /isActive/i);
});

test('validateAnnouncementInput rechaza fechas inválidas', () => {
  const { errors } = validateAnnouncementInput({ title: 'a', message: 'b', startsAt: 'ayer' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /startsAt/i);
});

test('validateAnnouncementInput acepta null como "sin límite"', () => {
  const { data, errors } = validateAnnouncementInput({
    title: 'a',
    message: 'b',
    startsAt: null,
    endsAt: null,
  });
  assert.deepEqual(errors, []);
  assert.equal(data.startsAt, null);
  assert.equal(data.endsAt, null);
});

test('validateAnnouncementInput rechaza startsAt posterior a endsAt', () => {
  const { errors } = validateAnnouncementInput({
    title: 'a',
    message: 'b',
    startsAt: '2026-07-01T00:00:00.000Z',
    endsAt: '2026-06-01T00:00:00.000Z',
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /startsAt|endsAt/i);
});

test('validateAnnouncementInput rechaza order no numérico', () => {
  const { errors } = validateAnnouncementInput({ title: 'a', message: 'b', order: 'abc' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /order/i);
});

test('validateAnnouncementInput partial valida solo lo provisto', () => {
  const { data, errors } = validateAnnouncementInput({ isActive: false }, { partial: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(data, { isActive: false });
});

test('validateAnnouncementInput partial con body vacío no genera errores', () => {
  const { data, errors } = validateAnnouncementInput({}, { partial: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(data, {});
});

// ── Route contracts ──────────────────────────────────────────────────────────

const listRoutes = (router) =>
  router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).map((method) => method.toUpperCase()),
    }));

test('el router admin expone el CRUD y el toggle', () => {
  const announcementRouter = require('../routes/announcement.routes');
  const routes = listRoutes(announcementRouter);
  const has = (path, method) =>
    routes.some((route) => route.path === path && route.methods.includes(method));

  assert.ok(has('/', 'GET'), 'falta GET /');
  assert.ok(has('/', 'POST'), 'falta POST /');
  assert.ok(has('/:id', 'PUT'), 'falta PUT /:id');
  assert.ok(has('/:id', 'DELETE'), 'falta DELETE /:id');
  assert.ok(has('/:id/toggle', 'PATCH'), 'falta PATCH /:id/toggle');
});

test('el router público expone GET /announcements', () => {
  const publicRouter = require('../routes/public.routes');
  const routes = listRoutes(publicRouter);
  assert.ok(
    routes.some((route) => route.path === '/announcements' && route.methods.includes('GET')),
    'falta GET /announcements',
  );
});

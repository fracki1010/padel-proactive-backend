'use strict';

// Unit tests for the temporary slot lock domain.
// The decision logic runs against an in-memory store that mimics the subset of
// Mongoose behavior the service depends on, so the whole lock lifecycle can be
// exercised without a live MongoDB connection.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-slot-lock';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SLOT_LOCK_TTL_MS,
  isLockActive,
  isOwnedBy,
  computeLockExpiry,
  resolveLockOutcome,
  acquireSlotLock,
  releaseSlotLock,
  buildForeignLockedKeys,
  applyLocksToAvailability,
} = require('../services/slotLock.service');

const SlotLock = require('../models/slotLock.model');

// ── In-memory store ──────────────────────────────────────────────────────────

const sameKey = (lock, { companyId, courtId, slotId, date }) =>
  String(lock.companyId) === String(companyId) &&
  String(lock.courtId) === String(courtId) &&
  String(lock.slotId) === String(slotId) &&
  new Date(lock.date).getTime() === new Date(date).getTime();

const createInMemoryStore = () => {
  const locks = [];
  const bookings = [];
  let seq = 0;

  return {
    locks,
    bookings,
    async deleteExpiredLocks({ companyId, courtId, slotId, date, now }) {
      for (let i = locks.length - 1; i >= 0; i -= 1) {
        const lock = locks[i];
        if (
          sameKey(lock, { companyId, courtId, slotId, date }) &&
          new Date(lock.expiresAt).getTime() <= new Date(now).getTime()
        ) {
          locks.splice(i, 1);
        }
      }
    },
    async findActiveBooking({ companyId, courtId, slotId, date }) {
      return (
        bookings.find(
          (booking) =>
            String(booking.status) !== 'cancelado' &&
            String(booking.companyId) === String(companyId) &&
            String(booking.courtId) === String(courtId) &&
            String(booking.slotId) === String(slotId) &&
            new Date(booking.date).getTime() === new Date(date).getTime(),
        ) || null
      );
    },
    async findActiveLocks({ companyId, courtId, slotId, date, now }) {
      return locks.filter(
        (lock) =>
          sameKey(lock, { companyId, courtId, slotId, date }) &&
          new Date(lock.expiresAt).getTime() > new Date(now).getTime(),
      );
    },
    async upsertLock({ companyId, courtId, slotId, date, holderId, expiresAt }) {
      const conflict = locks.find(
        (lock) =>
          sameKey(lock, { companyId, courtId, slotId, date }) &&
          String(lock.holderId) !== String(holderId),
      );
      if (conflict) {
        const error = new Error('E11000 duplicate key');
        error.code = 11000;
        throw error;
      }
      const own = locks.find(
        (lock) =>
          sameKey(lock, { companyId, courtId, slotId, date }) &&
          String(lock.holderId) === String(holderId),
      );
      if (own) {
        own.expiresAt = expiresAt;
        return { ...own };
      }
      const doc = {
        _id: `lock-${(seq += 1)}`,
        companyId,
        courtId,
        slotId,
        date,
        holderId,
        expiresAt,
      };
      locks.push(doc);
      return { ...doc };
    },
    async deleteOwnLock({ companyId, lockId, holderId }) {
      const index = locks.findIndex(
        (lock) =>
          String(lock._id) === String(lockId) &&
          String(lock.companyId) === String(companyId) &&
          String(lock.holderId) === String(holderId),
      );
      if (index === -1) return { deletedCount: 0 };
      locks.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
};

const COMPANY = 'company-a';
const COURT = 'court-1';
const SLOT = 'slot-20';
const DATE = new Date('2026-07-01T00:00:00.000Z');
const NOW = new Date('2026-06-15T12:00:00.000Z');

const acquire = (store, overrides = {}) =>
  acquireSlotLock({
    companyId: COMPANY,
    courtId: COURT,
    slotId: SLOT,
    date: DATE,
    holderId: 'holder-a',
    now: NOW,
    store,
    ...overrides,
  });

// ── Expiration helpers ───────────────────────────────────────────────────────

test('SLOT_LOCK_TTL_MS defaults to 5 minutos', () => {
  assert.equal(SLOT_LOCK_TTL_MS, 5 * 60 * 1000);
});

test('computeLockExpiry suma el TTL a now', () => {
  const expiry = computeLockExpiry(NOW, SLOT_LOCK_TTL_MS);
  assert.equal(expiry.getTime(), NOW.getTime() + SLOT_LOCK_TTL_MS);
});

test('isLockActive: true sólo con expiresAt futuro', () => {
  assert.equal(isLockActive({ expiresAt: new Date(NOW.getTime() + 1000) }, NOW), true);
  assert.equal(isLockActive({ expiresAt: new Date(NOW.getTime() - 1000) }, NOW), false);
  assert.equal(isLockActive({ expiresAt: NOW }, NOW), false);
  assert.equal(isLockActive(null, NOW), false);
});

test('isOwnedBy compara holderId como string', () => {
  assert.equal(isOwnedBy({ holderId: 'holder-a' }, 'holder-a'), true);
  assert.equal(isOwnedBy({ holderId: 'holder-a' }, 'holder-b'), false);
  assert.equal(isOwnedBy(null, 'holder-a'), false);
});

// ── Decision logic ───────────────────────────────────────────────────────────

test('resolveLockOutcome: slot libre habilita el lock', () => {
  const outcome = resolveLockOutcome({
    activeBooking: null,
    activeLocks: [],
    holderId: 'holder-a',
    now: NOW,
  });
  assert.equal(outcome.ok, true);
});

test('resolveLockOutcome: reserva activa gana sobre el lock', () => {
  const outcome = resolveLockOutcome({
    activeBooking: { _id: 'booking-1' },
    activeLocks: [],
    holderId: 'holder-a',
    now: NOW,
  });
  assert.deepEqual(outcome, { ok: false, reason: 'booked' });
});

test('resolveLockOutcome: lock vivo de otro holder rechaza', () => {
  const outcome = resolveLockOutcome({
    activeBooking: null,
    activeLocks: [{ holderId: 'holder-b', expiresAt: new Date(NOW.getTime() + 1000) }],
    holderId: 'holder-a',
    now: NOW,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'locked_by_other');
});

test('resolveLockOutcome: lock vencido de otro holder no bloquea', () => {
  const outcome = resolveLockOutcome({
    activeBooking: null,
    activeLocks: [],
    holderId: 'holder-a',
    now: NOW,
  });
  assert.equal(outcome.ok, true);
});

test('resolveLockOutcome: el mismo holder puede renovar su lock', () => {
  const outcome = resolveLockOutcome({
    activeBooking: null,
    activeLocks: [{ holderId: 'holder-a', expiresAt: new Date(NOW.getTime() + 1000) }],
    holderId: 'holder-a',
    now: NOW,
  });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.renewLock);
});

// ── acquireSlotLock lifecycle ────────────────────────────────────────────────

test('acquireSlotLock: crea lock en un turno libre', async () => {
  const store = createInMemoryStore();
  const result = await acquire(store);
  assert.equal(result.ok, true);
  assert.equal(store.locks.length, 1);
  assert.equal(store.locks[0].holderId, 'holder-a');
  assert.equal(result.expiresAt.getTime(), NOW.getTime() + SLOT_LOCK_TTL_MS);
});

test('acquireSlotLock: renueva el lock propio sin duplicar', async () => {
  const store = createInMemoryStore();
  await acquire(store);
  const later = new Date(NOW.getTime() + 60_000);
  const renewed = await acquire(store, { now: later });
  assert.equal(renewed.ok, true);
  assert.equal(store.locks.length, 1);
  assert.equal(renewed.expiresAt.getTime(), later.getTime() + SLOT_LOCK_TTL_MS);
});

test('acquireSlotLock: rechaza si el turno ya tiene reserva', async () => {
  const store = createInMemoryStore();
  store.bookings.push({
    companyId: COMPANY,
    courtId: COURT,
    slotId: SLOT,
    date: DATE,
    status: 'reservado',
  });
  const result = await acquire(store);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'booked');
  assert.equal(store.locks.length, 0);
});

test('acquireSlotLock: rechaza si otro holder lo está reservando', async () => {
  const store = createInMemoryStore();
  await acquire(store, { holderId: 'holder-a' });
  const result = await acquire(store, { holderId: 'holder-b' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locked_by_other');
  assert.equal(store.locks.length, 1);
  assert.equal(store.locks[0].holderId, 'holder-a');
});

test('acquireSlotLock: un lock vencido no bloquea a otro holder', async () => {
  const store = createInMemoryStore();
  store.locks.push({
    _id: 'expired-1',
    companyId: COMPANY,
    courtId: COURT,
    slotId: SLOT,
    date: DATE,
    holderId: 'holder-a',
    expiresAt: new Date(NOW.getTime() - 1000),
  });
  const result = await acquire(store, { holderId: 'holder-b' });
  assert.equal(result.ok, true);
  assert.equal(store.locks.length, 1);
  assert.equal(store.locks[0].holderId, 'holder-b');
});

// ── releaseSlotLock ──────────────────────────────────────────────────────────

test('releaseSlotLock: el dueño libera su lock', async () => {
  const store = createInMemoryStore();
  const acquired = await acquire(store);
  const released = await releaseSlotLock({
    companyId: COMPANY,
    lockId: acquired.lock._id,
    holderId: 'holder-a',
    store,
  });
  assert.equal(released.ok, true);
  assert.equal(store.locks.length, 0);
});

test('releaseSlotLock: otro holder no puede liberar el lock', async () => {
  const store = createInMemoryStore();
  const acquired = await acquire(store);
  const released = await releaseSlotLock({
    companyId: COMPANY,
    lockId: acquired.lock._id,
    holderId: 'holder-b',
    store,
  });
  assert.equal(released.ok, false);
  assert.equal(store.locks.length, 1);
});

// ── Availability integration ─────────────────────────────────────────────────

test('buildForeignLockedKeys: ignora locks propios y vencidos', () => {
  const keys = buildForeignLockedKeys(
    [
      { courtId: 'c1', slotId: 's1', holderId: 'holder-b', expiresAt: new Date(NOW.getTime() + 1000) },
      { courtId: 'c2', slotId: 's1', holderId: 'holder-a', expiresAt: new Date(NOW.getTime() + 1000) },
      { courtId: 'c3', slotId: 's1', holderId: 'holder-b', expiresAt: new Date(NOW.getTime() - 1000) },
    ],
    'holder-a',
    NOW,
  );
  assert.deepEqual([...keys], ['c1_s1']);
});

test('applyLocksToAvailability: marca no disponible el lock de otro holder', () => {
  const availability = [
    { courtId: 'c1', slotId: 's1', available: true },
    { courtId: 'c2', slotId: 's1', available: true },
  ];
  const result = applyLocksToAvailability({
    availability,
    locks: [
      { courtId: 'c1', slotId: 's1', holderId: 'holder-b', expiresAt: new Date(NOW.getTime() + 1000) },
    ],
    holderId: 'holder-a',
    now: NOW,
  });
  assert.equal(result[0].available, false);
  assert.equal(result[0].locked, true);
  assert.equal(result[1].available, true);
});

test('applyLocksToAvailability: el lock del propio holder no oculta su turno', () => {
  const result = applyLocksToAvailability({
    availability: [{ courtId: 'c1', slotId: 's1', available: true }],
    locks: [
      { courtId: 'c1', slotId: 's1', holderId: 'holder-a', expiresAt: new Date(NOW.getTime() + 1000) },
    ],
    holderId: 'holder-a',
    now: NOW,
  });
  assert.equal(result[0].available, true);
});

// ── Model indexes ────────────────────────────────────────────────────────────

test('SlotLock define índice TTL sobre expiresAt', () => {
  const indexes = SlotLock.schema.indexes();
  const ttl = indexes.find(
    ([definition, options]) =>
      definition.expiresAt === 1 && options?.expireAfterSeconds === 0,
  );
  assert.ok(ttl, 'falta índice TTL con expireAfterSeconds: 0');
});

test('SlotLock define índice único por slot', () => {
  const indexes = SlotLock.schema.indexes();
  const unique = indexes.find(
    ([definition, options]) =>
      definition.companyId === 1 &&
      definition.courtId === 1 &&
      definition.slotId === 1 &&
      definition.date === 1 &&
      options?.unique === true,
  );
  assert.ok(unique, 'falta índice único por (companyId, courtId, slotId, date)');
});

// ── Route contracts ──────────────────────────────────────────────────────────

const listRoutes = (router) =>
  router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).map((method) => method.toUpperCase()),
    }));

test('el router público expone POST /slot-lock y DELETE /slot-lock/:id', () => {
  const publicRouter = require('../routes/public.routes');
  const routes = listRoutes(publicRouter);
  const has = (path, method) =>
    routes.some((route) => route.path === path && route.methods.includes(method));

  assert.ok(has('/slot-lock', 'POST'), 'falta POST /slot-lock');
  assert.ok(has('/slot-lock/:id', 'DELETE'), 'falta DELETE /slot-lock/:id');
});

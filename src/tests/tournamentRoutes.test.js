'use strict';

// Real Express app: the /api/tournaments guard must be admin-only (spec TM-R1).
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-tournament-routes';
const app = require('../app');
const stack = (app.router || app._router).stack;

const tournamentGuard = () => {
  const index = stack.findIndex((layer) => layer.name === 'requireTenant');
  assert.ok(index > 0, 'the /api/tournaments mount was not found');
  return stack[index - 1].handle;
};

const invoke = (guard, role) => {
  const result = { statusCode: null, nextCalled: false };
  const res = { status(code) { result.statusCode = code; return this; }, json() { return this; } };
  guard({ user: { role, companyId: 'company-a' } }, res, () => { result.nextCalled = true; });
  return result;
};

test('the tournament API mount is admin-only (TM-R1)', () => {
  const guard = tournamentGuard();
  const manager = invoke(guard, 'manager');
  assert.deepEqual(manager, { statusCode: 403, nextCalled: false });
  const admin = invoke(guard, 'admin');
  assert.deepEqual(admin, { statusCode: null, nextCalled: true });
});

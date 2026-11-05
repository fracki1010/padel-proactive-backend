'use strict';

// PUT /api/config/club-closures/:id must validate the resulting range BEFORE
// writing. An inverted range (startDate > endDate) used to be persisted first
// and rejected afterwards, leaving a corrupt closure in the database.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-club-closure-config';

const CompanyA = 'company-a';
const CLOSURE_ID = '64b0000000000000000000e1';

const state = {
  target: null,
  updateCalls: 0,
};

const resetState = () => {
  state.target = {
    _id: CLOSURE_ID,
    companyId: CompanyA,
    startDate: '2099-01-10',
    endDate: '2099-01-12',
    reason: 'Mantenimiento',
  };
  state.updateCalls = 0;
};

beforeEach(resetState);
resetState();

const ClubClosure = require('../models/clubClosure.model');
ClubClosure.findOne = async () => state.target;
ClubClosure.findOneAndUpdate = async (filter, update) => {
  state.updateCalls += 1;
  state.target = { ...state.target, ...update };
  return state.target;
};

const router = require('../routes/config.routes');

const putLayer = router.stack.find(
  (layer) => layer.route?.methods?.put && layer.route.path === '/club-closures/:id',
);
const putHandler = putLayer.route.stack[putLayer.route.stack.length - 1].handle;

const createResponse = () => ({
  statusCode: undefined,
  payload: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.payload = body;
    return this;
  },
});

const updateClosure = async (body) => {
  const res = createResponse();
  await putHandler(
    {
      params: { id: CLOSURE_ID },
      user: { role: 'admin', companyId: CompanyA, _id: 'admin-1' },
      body,
    },
    res,
  );
  return res;
};

test('an inverted range is rejected before findOneAndUpdate persists it', async () => {
  const res = await updateClosure({ startDate: '2099-02-01' });

  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /inicio no puede ser posterior/i);
  assert.equal(state.updateCalls, 0, 'no write may happen for an inverted range');
});

test('a valid range update is persisted exactly once', async () => {
  const res = await updateClosure({ startDate: '2099-01-01' });

  assert.equal(res.statusCode, 200);
  assert.equal(state.updateCalls, 1);
  assert.equal(res.payload.data.startDate, '2099-01-01');
});

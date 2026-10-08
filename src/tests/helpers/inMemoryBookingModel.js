'use strict';

// Minimal in-memory stand-in for the Mongoose Booking model. It supports the
// exact query/update surface the deposit lifecycle uses, including MongoDB
// update pipelines ($set of $subtract/$max/$ifNull/$$NOW). findOneAndUpdate is
// synchronous up to its (single) write, so concurrent calls are observed by the
// same atomicity guarantees as a real single-document update: only one of a
// competing approve/expire pair can match the status guard.

const getPath = (obj, path) =>
  String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);

const setPath = (obj, path, value) => {
  const keys = String(path).split('.');
  let target = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (target[key] == null || typeof target[key] !== 'object') {
      target[key] = {};
    }
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
};

const matchesCondition = (value, condition) => {
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    if ('$lt' in condition) {
      return value != null && new Date(value).getTime() < new Date(condition.$lt).getTime();
    }
    if ('$lte' in condition) {
      return value != null && new Date(value).getTime() <= new Date(condition.$lte).getTime();
    }
    if ('$gt' in condition) {
      return value != null && new Date(value).getTime() > new Date(condition.$gt).getTime();
    }
    if ('$ne' in condition) return String(value) !== String(condition.$ne);
    if ('$in' in condition) return condition.$in.some((item) => String(item) === String(value));
    if ('$exists' in condition) return (value !== undefined) === condition.$exists;
  }
  return String(value) === String(condition);
};

const matches = (doc, filter) =>
  Object.entries(filter || {}).every(([key, condition]) =>
    matchesCondition(getPath(doc, key), condition),
  );

const evaluate = (doc, expr) => {
  if (expr === '$$NOW') return new Date();
  if (typeof expr === 'string' && expr.startsWith('$')) return getPath(doc, expr.slice(1));
  if (Array.isArray(expr)) return expr.map((item) => evaluate(doc, item));
  if (expr && typeof expr === 'object') {
    if ('$subtract' in expr) {
      const [left, right] = evaluate(doc, expr.$subtract);
      return Number(left || 0) - Number(right || 0);
    }
    if ('$max' in expr) {
      const values = evaluate(doc, expr.$max);
      return Math.max(...values.map((value) => Number(value || 0)));
    }
    if ('$ifNull' in expr) {
      const [value, fallback] = evaluate(doc, expr.$ifNull);
      return value == null ? fallback : value;
    }
  }
  return expr;
};

const applyUpdate = (doc, update) => {
  const stages = Array.isArray(update) ? update : [update];
  for (const stage of stages) {
    const sets = stage.$set || {};
    for (const [key, expr] of Object.entries(sets)) {
      setPath(doc, key, evaluate(doc, expr));
    }
  }
  return doc;
};

const createInMemoryBookingModel = (initialBookings = []) => {
  const bookings = initialBookings.map((booking) => ({ ...booking }));

  return {
    bookings,
    async findOneAndUpdate(filter, update, options = {}) {
      const doc = bookings.find((booking) => matches(booking, filter));
      if (!doc) return null;
      applyUpdate(doc, update);
      if (options.returnDocument === 'before') return null;
      return { ...doc };
    },
    async updateOne(filter, update) {
      const doc = bookings.find((booking) => matches(booking, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(doc, update);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async find(filter = {}) {
      return bookings.filter((booking) => matches(booking, filter)).map((booking) => ({ ...booking }));
    },
    async countDocuments(filter = {}) {
      return bookings.filter((booking) => matches(booking, filter)).length;
    },
  };
};

module.exports = {
  applyUpdate,
  createInMemoryBookingModel,
  evaluate,
  matches,
};

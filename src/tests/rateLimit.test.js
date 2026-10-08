'use strict';

// The in-memory rate limiter backs a public webhook, so unbounded key growth is
// a DoS vector. It must evict tracked keys once the configured cap is reached.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../middleware/rateLimit.middleware');

const createResponse = () => ({
  statusCode: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json() {
    return this;
  },
});

test('the limiter bounds the number of tracked keys (LRU-style eviction)', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 5, maxTrackedKeys: 2 });

  limiter({ ip: '10.0.0.1' }, createResponse(), () => {});
  limiter({ ip: '10.0.0.2' }, createResponse(), () => {});
  limiter({ ip: '10.0.0.3' }, createResponse(), () => {});

  assert.equal(typeof limiter.trackedKeyCount, 'function');
  assert.ok(
    limiter.trackedKeyCount() <= 2,
    `tracked keys must stay bounded, got ${limiter.trackedKeyCount()}`,
  );
});

test('the limiter still rate limits the most recent key after eviction', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, maxRequests: 2, maxTrackedKeys: 1 });
  const ip = '10.0.0.9';

  limiter({ ip }, createResponse(), () => {});
  limiter({ ip }, createResponse(), () => {});
  const blocked = createResponse();
  limiter({ ip }, blocked, () => {});
  assert.equal(blocked.statusCode, 429);
});

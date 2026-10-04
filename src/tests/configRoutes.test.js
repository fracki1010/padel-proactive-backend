'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const shared = require('../routes/config/shared');
const courtsRouter = require('../routes/config/courts.routes');
const slotsRouter = require('../routes/config/slots.routes');
const whatsappRouter = require('../routes/config/whatsapp.routes');
const notificationsRouter = require('../routes/config/notifications.routes');
const botAutomationRouter = require('../routes/config/botAutomation.routes');
const penaltiesRouter = require('../routes/config/penalties.routes');
const clubClosuresRouter = require('../routes/config/clubClosures.routes');
const companyImagesRouter = require('../routes/config/companyImages.routes');
const configRouter = require('../routes/config.routes');

const paths = (router) =>
  router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);

const allPaths = (router) =>
  router.stack.flatMap((layer) => {
    if (layer.route) return [layer.route.path];
    if (layer.handle?.stack) return allPaths(layer.handle);
    return [];
  });

test('shared exports the config helpers and regexes', () => {
  assert.strictEqual(typeof shared.resolveCompanyId, 'function');
  assert.strictEqual(typeof shared.escapeRegex, 'function');
  assert.strictEqual(typeof shared.companyScope, 'function');
  assert.strictEqual(typeof shared.firstBoolean, 'function');
  assert.strictEqual(typeof shared.firstString, 'function');
  assert.strictEqual(typeof shared.buildWhatsappConfigResponse, 'function');
  assert.strictEqual(typeof shared.buildBotAutomationConfigResponse, 'function');
  assert.ok(shared.DAILY_HOUR_REGEX.test('23:59'));
  assert.ok(shared.ISO_DATE_REGEX.test('2026-04-07'));
  assert.ok(!shared.ISO_DATE_REGEX.test('07-04-2026'));
});

test('courts router exposes the /courts CRUD paths', () => {
  const p = paths(courtsRouter);
  assert.strictEqual(p.filter((x) => x === '/courts').length, 2);
  assert.strictEqual(p.filter((x) => x === '/courts/:id').length, 2);
});

test('slots router exposes the /slots paths with base-price before :id', () => {
  const p = paths(slotsRouter);
  assert.strictEqual(p.filter((x) => x === '/slots').length, 2);
  assert.strictEqual(p.filter((x) => x === '/slots/base-price').length, 1);
  assert.strictEqual(p.filter((x) => x === '/slots/:id').length, 1);
  assert.ok(p.indexOf('/slots/base-price') < p.indexOf('/slots/:id'));
});

test('escapeRegex escapes regex metacharacters', () => {
  assert.strictEqual(shared.escapeRegex('a.b+c'), 'a\\.b\\+c');
  assert.strictEqual(shared.escapeRegex('plain'), 'plain');
});

test('firstBoolean and firstString pick the first defined candidate', () => {
  assert.strictEqual(shared.firstBoolean([undefined, false, true]), false);
  assert.strictEqual(shared.firstString([undefined, 'x', 'y']), 'x');
});

test('whatsapp router exposes the /whatsapp paths', () => {
  const p = paths(whatsappRouter);
  assert.strictEqual(p.filter((x) => x === '/whatsapp').length, 3);
  assert.strictEqual(p.filter((x) => x === '/whatsapp/send-digest-now').length, 1);
  assert.strictEqual(p.filter((x) => x === '/whatsapp/reset-session').length, 1);
  assert.strictEqual(p.filter((x) => x === '/whatsapp/groups').length, 1);
  assert.strictEqual(p.filter((x) => x === '/whatsapp/chats').length, 1);
});

test('notifications router exposes reminders and settings aliases', () => {
  const p = paths(notificationsRouter);
  assert.strictEqual(p.filter((x) => x === '/notifications/reminders').length, 3);
  assert.strictEqual(p.filter((x) => x === '/settings').length, 3);
});

test('botAutomation router exposes the /bot-automation paths', () => {
  const p = paths(botAutomationRouter);
  assert.strictEqual(p.filter((x) => x === '/bot-automation').length, 3);
});

test('penalties router exposes the /penalties paths', () => {
  const p = paths(penaltiesRouter);
  assert.strictEqual(p.filter((x) => x === '/penalties').length, 2);
});

test('clubClosures router exposes the /club-closures CRUD paths', () => {
  const p = paths(clubClosuresRouter);
  assert.strictEqual(p.filter((x) => x === '/club-closures').length, 2);
  assert.strictEqual(p.filter((x) => x === '/club-closures/:id').length, 2);
});

test('companyImages router exposes image and client-log paths', () => {
  const p = paths(companyImagesRouter);
  assert.strictEqual(p.filter((x) => x === '/company-images').length, 2);
  assert.strictEqual(p.filter((x) => x === '/company-images/:id').length, 1);
  assert.strictEqual(p.filter((x) => x === '/client-log').length, 1);
});

test('aggregator mounts every sub-router with byte-identical URL paths', () => {
  const expected = [
    ...paths(courtsRouter),
    ...paths(slotsRouter),
    ...paths(whatsappRouter),
    ...paths(notificationsRouter),
    ...paths(botAutomationRouter),
    ...paths(penaltiesRouter),
    ...paths(clubClosuresRouter),
    ...paths(companyImagesRouter),
  ].sort();
  const actual = allPaths(configRouter).sort();
  assert.strictEqual(actual.length, expected.length);
  assert.deepStrictEqual(actual, expected);
});
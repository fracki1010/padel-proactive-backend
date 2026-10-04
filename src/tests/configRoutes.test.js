'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const shared = require('../routes/config/shared');
const courtsRouter = require('../routes/config/courts.routes');
const slotsRouter = require('../routes/config/slots.routes');
const whatsappRouter = require('../routes/config/whatsapp.routes');
const notificationsRouter = require('../routes/config/notifications.routes');
const botAutomationRouter = require('../routes/config/botAutomation.routes');

const paths = (router) =>
  router.stack.filter((layer) => layer.route).map((layer) => layer.route.path);

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
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseAttendanceAnswer,
  parseStrictYesNoAnswer,
  parseStrictCancel,
  parseStrictOfferConfirmation,
  getStrictInputState,
  isAllowedInputForStrictState,
  buildStrictStateInvalidInputReply,
  isAwaitingConcreteAnswer,
  enforceStrictQuestionFlowReply,
  ALLOWED_AI_ACTIONS,
  CONCRETE_RESPONSE_TIMEOUT_MS,
} = require('../whatsapp/domain/strictFlow');

test('parseAttendanceAnswer maps 1/2 and si/no asisto', () => {
  assert.strictEqual(parseAttendanceAnswer('1'), 'YES');
  assert.strictEqual(parseAttendanceAnswer('no asisto'), 'NO');
  assert.strictEqual(parseAttendanceAnswer('hola'), null);
});

test('parseStrictYesNoAnswer maps si/no', () => {
  assert.strictEqual(parseStrictYesNoAnswer('si'), 'YES');
  assert.strictEqual(parseStrictYesNoAnswer('no'), 'NO');
  assert.strictEqual(parseStrictYesNoAnswer('quizas'), null);
});

test('parseStrictCancel detects cancel intent', () => {
  assert.strictEqual(parseStrictCancel('cancelar'), true);
  assert.strictEqual(parseStrictCancel('hola'), false);
});

test('parseStrictOfferConfirmation detects explicit confirmation', () => {
  assert.strictEqual(parseStrictOfferConfirmation('confirmar reserva'), true);
  assert.strictEqual(parseStrictOfferConfirmation('hola'), false);
});

test('getStrictInputState derives the current strict state from meta', () => {
  assert.strictEqual(getStrictInputState({ awaitingFullNameForBooking: true }), 'FULL_NAME_CAPTURE');
  assert.strictEqual(getStrictInputState({}), null);
});

test('isAllowedInputForStrictState gates input per state', () => {
  assert.strictEqual(isAllowedInputForStrictState('si', 'NAME_CONFIRMATION', {}), true);
  assert.strictEqual(isAllowedInputForStrictState('hola', 'NAME_CONFIRMATION', {}), false);
  assert.strictEqual(isAllowedInputForStrictState('cualquier cosa', null, {}), true);
});

test('buildStrictStateInvalidInputReply returns the state-specific prompt', () => {
  assert.strictEqual(
    buildStrictStateInvalidInputReply('NAME_CONFIRMATION'),
    'Para continuar, respondé únicamente *SI* o *NO*.',
  );
});

test('isAwaitingConcreteAnswer reflects pending strict state', () => {
  assert.strictEqual(isAwaitingConcreteAnswer({ awaitingFullNameForBooking: true }), true);
  assert.strictEqual(isAwaitingConcreteAnswer({}), false);
});

test('enforceStrictQuestionFlowReply asks one question at a time', () => {
  assert.strictEqual(
    enforceStrictQuestionFlowReply('Decime tu nombre y fecha'),
    'Antes de continuar, pasame tu *nombre completo* (ej: *Juan Pérez*).',
  );
  assert.strictEqual(enforceStrictQuestionFlowReply('hola'), 'hola');
  assert.strictEqual(
    enforceStrictQuestionFlowReply('¿Querés reservar hoy a las 20? ¿O mañana?'),
    '¿Querés reservar hoy a las 20?\n\nRespondé eso y avanzamos paso a paso.',
  );
});

test('strictFlow exports the AI action allowlist and concrete timeout', () => {
  assert.ok(ALLOWED_AI_ACTIONS instanceof Set);
  assert.ok(ALLOWED_AI_ACTIONS.has('CREATE_BOOKING'));
  assert.strictEqual(CONCRETE_RESPONSE_TIMEOUT_MS, 3 * 60 * 1000);
});
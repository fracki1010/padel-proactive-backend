'use strict';

const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { ESLint } = require('eslint');
const config = require('../../eslint.config.js');

// Lints a code snippet through the real flat config (including `files`
// matching, like the CLI does). The virtual file lives under src/ so the
// config's `files: ['src/**/*.js']` scope applies.
async function lint(code) {
  const eslint = new ESLint({ overrideConfig: config, overrideConfigFile: true });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(process.cwd(), 'src', 'tests', '__lint_fixture__.js'),
  });
  return result.messages;
}

test('no-undef flags an undefined variable in legacy commonjs code', async () => {
  const messages = await lint('function reply() { return missingVariable; }');
  assert.ok(
    messages.some((m) => m.ruleId === 'no-undef'),
    `expected a no-undef message, got: ${JSON.stringify(messages)}`
  );
});

test('clean commonjs code produces no lint messages', async () => {
  const messages = await lint('const greeting = "hola"; module.exports = { greeting };');
  assert.strictEqual(messages.length, 0, JSON.stringify(messages));
});

test('node globals (require, process, __dirname) do not trigger no-undef', async () => {
  const messages = await lint(
    'const path = require("path");\n' +
      'if (process.env.NODE_ENV === "production") {\n' +
      '  module.exports = path.join(__dirname, "dist");\n' +
      '}'
  );
  assert.strictEqual(messages.length, 0, JSON.stringify(messages));
});
const test = require("node:test");
const assert = require("node:assert/strict");

const { extractPersonName } = require("../whatsapp/domain/extractPersonName");

test("mi nombre es Juan Perez -> Juan Perez", () => {
  const result = extractPersonName("mi nombre es Juan Perez");
  assert.equal(result.isValid, true);
  assert.equal(result.value, "Juan Perez");
});

test("soy Martin Perez -> Martin Perez", () => {
  const result = extractPersonName("soy Martin Perez");
  assert.equal(result.isValid, true);
  assert.equal(result.value, "Martin Perez");
});

test("mi nombre es Iñaki Muñoz", () => {
  const result = extractPersonName("mi nombre es Iñaki Muñoz");
  assert.equal(result.isValid, true);
  assert.equal(result.value, "Iñaki Muñoz");
});

test("mi nombre es Jean-Luc Picard", () => {
  const result = extractPersonName("mi nombre es Jean-Luc Picard");
  assert.equal(result.isValid, true);
  assert.equal(result.value, "Jean-Luc Picard");
});

test("mi nombre es O'Connor Diaz", () => {
  const result = extractPersonName("mi nombre es O'Connor Diaz");
  assert.equal(result.isValid, true);
  assert.equal(result.value, "O'Connor Diaz");
});

test("mi nombre es Juan -> inválido", () => {
  const result = extractPersonName("mi nombre es Juan");
  assert.equal(result.isValid, false);
  assert.equal(result.reason, "missing_last_name");
});

test("juan 123 -> inválido", () => {
  const result = extractPersonName("juan 123");
  assert.equal(result.isValid, false);
  assert.equal(result.reason, "contains_digits");
});

test("payload extraño -> inválido", () => {
  const result = extractPersonName("mi nombre es Robert'); DROP TABLE users;--");
  assert.equal(result.isValid, false);
  assert.equal(result.reason, "suspicious_payload");
});

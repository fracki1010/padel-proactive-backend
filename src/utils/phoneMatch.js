'use strict';

// Phone matching helpers shared by the client-auth resolution paths.
//
// Argentine numbers get stored in several shapes over time (with/without the
// mobile 9, with/without the 54 country code, sometimes locally only). To
// recognise an EXISTING client when someone verifies with their number we must
// compare digit-agnostically, not by exact string.

const digitsOnly = (value = '') => String(value || '').replace(/\D/g, '');

// Canonical candidate spellings for a phone input (input may be raw).
// Returns digits-only strings; the caller matches with `$in: candidates`.
const phoneCandidates = (raw) => {
  const digits = digitsOnly(raw);
  if (!digits) return [];
  const out = new Set([digits]);

  if (digits.startsWith('549')) {
    out.add(`54${digits.slice(3)}`); // drop the mobile 9
    out.add(digits.slice(3));
  } else if (digits.startsWith('54')) {
    out.add(digits.slice(2)); // drop the country code
  } else {
    out.add(`54${digits}`);
    out.add(`549${digits}`);
  }

  // Local (area + number) form, used by older rows without the country code.
  if (digits.length >= 10) out.add(digits.slice(-10));

  return [...out].filter(Boolean);
};

// Regex over the last 10 digits allowing any separators between them, used as a
// last-resort fallback for rows stored with spaces/pluses/etc.
const phoneLooseRegex = (raw) => {
  const digits = digitsOnly(raw);
  if (digits.length < 8) return null;
  const tail = digits.slice(-10);
  // Unanchored: the tail may be preceded by a country code (54/549/9).
  return new RegExp(tail.split('').join('\\D*'));
};

// QA/automation artefacts: the defensive WhatsApp test suite tags its users with
// a `qa-*` whatsappId (e.g. "qa-suite:...", "qa-defensive-server:..."). Real
// clients never carry that prefix.
const isQaUser = (user = {}) => /^qa-/i.test(String(user.whatsappId || '').trim());

module.exports = { digitsOnly, phoneCandidates, phoneLooseRegex, isQaUser };

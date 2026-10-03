'use strict';

const globals = require('globals');

// Minimal flat config for legacy commonjs codebase.
// Only `no-undef` is enabled; everything else stays off so the
// 3000+ line legacy files can lint green. Tighter rules are future
// hardening, out of scope for this change (see design D6).
module.exports = [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
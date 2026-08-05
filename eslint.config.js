'use strict';

// ESLint 9 flat config. Vendored libraries are never linted — they are third-party minified
// builds copied in by scripts/vendor.js.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'dist/**', 'renderer/vendor/**'] },

  js.configs.recommended,

  {
    files: [
      'eslint.config.js',
      'main.js',
      'preload.js',
      'main/**/*.js',
      'scripts/**/*.js',
      'test/**/*.js'
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node
    }
  },

  {
    files: ['renderer/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      // marked, DOMPurify and highlight.js are the vendored libraries, loaded before renderer.js.
      globals: {
        ...globals.browser,
        marked: 'readonly',
        DOMPurify: 'readonly',
        hljs: 'readonly'
      }
    }
  },

  {
    // lib.js is loaded both as a browser script and by node:test, so its UMD footer
    // touches `module` when one exists.
    files: ['renderer/lib.js'],
    languageOptions: { globals: { module: 'readonly' } }
  }
];

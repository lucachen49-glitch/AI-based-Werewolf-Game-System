const noUnsanitized = require('eslint-plugin-no-unsanitized');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'output/**',
      '.video-venv/**',
      '.voice-venv/**',
      'logs/**',
      'archive/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      'no-unsanitized/property': 'error',
      'no-unsanitized/method': 'error',
    },
  },
];

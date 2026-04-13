const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      'trader-ui/dist/**',
      'trader-ui/node_modules/**',
      'node_modules/**',
      'coverage/**',
      'dist/**',
      '*.min.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.jest, fetch: 'readonly', Response: 'readonly' },
    },
    rules: {
      // Encourage correctness without forcing a huge legacy refactor
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_|^(req|res|next|err)$',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_|^err$',
      }],
      'no-undef': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-useless-catch': 'warn',
      'prefer-const': 'warn',
      'no-var': 'error',
      eqeqeq: ['warn', 'smart'],
      // Too noisy for our defensive "let x = default; try { x = await fetch() } catch" patterns
      'no-useless-assignment': 'off',
    },
  },
  // Jest files need slightly relaxed rules
  {
    files: ['tests/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  prettier, // must be last so it disables stylistic rules that Prettier owns
];

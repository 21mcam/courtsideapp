import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['client/dist/**', 'node_modules/**', 'client/node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  {
    // Playwright config + specs run under node, but page.evaluate
    // callbacks execute in the browser — allow both global sets.
    files: ['client/playwright.config.js', 'client/e2e/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ['client/**/*.{js,jsx}'],
    ignores: ['client/playwright.config.js', 'client/e2e/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // PascalCase identifiers are React components; without
      // eslint-plugin-react, plain ESLint doesn't see <App /> as a
      // use of `App`, so we exempt PascalCase from the unused-vars
      // check on the client side — for locals AND destructured params
      // (`{ icon: Icon }`). lowerCamelCase still warns.
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_|^[A-Z]', varsIgnorePattern: '^[A-Z]' },
      ],
    },
  },
  prettier,
];

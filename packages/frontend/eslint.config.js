// Minimal ESLint config: Biome (root `biome.json`) does all general linting and
// formatting. This file keeps only the Expo rules Biome has no equivalent for,
// and `expo lint` runs it (`bun run lint` at the root runs both).
//
// - `expo/no-env-var-destructuring` / `expo/no-dynamic-env-var`: Metro inlines
//   `process.env.EXPO_PUBLIC_*` only when it is read as a static member
//   expression. A destructured or computed read silently becomes `undefined`
//   in the bundle.
// - `expo/use-dom-exports`: a `'use dom'` component file must export exactly
//   one default React component.
const { defineConfig } = require('eslint/config');
const tsParser = require('@typescript-eslint/parser');
const expo = require('eslint-plugin-expo');

module.exports = defineConfig([
  {
    ignores: ['dist/*', 'android/*', 'ios/*'],
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { expo },
    rules: {
      'expo/no-env-var-destructuring': 'error',
      'expo/no-dynamic-env-var': 'error',
      'expo/use-dom-exports': 'error',
    },
  },
]);

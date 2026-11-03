// Minimal ESLint config: Biome (root `biome.json`) does all general linting and
// formatting. This keeps only the Expo rules Biome has no equivalent for:
// Metro inlines `process.env.EXPO_PUBLIC_*` only when it is read as a static
// member expression, so a destructured or computed read silently becomes
// `undefined` in the bundle. Run as `expo lint .`: bare `expo lint` skips files
// outside app/, components/ and src/.
const { defineConfig } = require('eslint/config');
const tsParser = require('@typescript-eslint/parser');
const expo = require('eslint-plugin-expo');

module.exports = defineConfig([
  {
    ignores: ['dist/*', 'android/*', 'ios/*', '.expo/*'],
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

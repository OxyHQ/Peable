// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "android/*", "ios/*"],
  },
  {
    files: [
      "app/(tabs)/index.tsx",
      "src/ui/components/SuggestionStack.tsx",
      "src/ui/sheets/SendReceiveSheet.tsx",
    ],
    rules: {
      // React's generic ref rules do not model Reanimated SharedValue worklets.
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
    },
  },
  {
    // The Electron main/preload processes are CommonJS Node, not the Expo
    // bundle: they legitimately use `__dirname`, `Buffer` and friends.
    files: ["electron/**/*.js"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
        process: "readonly",
        module: "writable",
        require: "readonly",
      },
    },
  },
  {
    files: [
      "src/p2p/socket-provider.ts",
      "src/services/push-handler.ts",
      "src/services/push-registration.ts",
      "src/storage/kv-store.ts",
      "src/utils/haptics.ts",
    ],
    rules: {
      // These native-only modules load optional platform implementations lazily.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");

// Expo's getDefaultConfig auto-detects this bun workspace and already makes
// Metro monorepo-aware under the hoisted linker: it sets `watchFolders` (root
// node_modules + every package), `resolver.nodeModulesPaths`
// ([app node_modules, hoisted root node_modules]) and enables
// `unstable_enablePackageExports` (required by @oxy.so/bloom subpath exports).
// We keep those defaults untouched and only layer on this app's own needs.
const config = getDefaultConfig(projectRoot);

// ---------------------------------------------------------------------------
// Crypto polyfill: inject before all other modules so globalThis.crypto
// is available when @noble/hashes captures it at import time.
// ---------------------------------------------------------------------------

const originalGetModules =
  config.serializer?.getModulesRunBeforeMainModule ?? (() => []);

config.serializer = {
  ...config.serializer,
  getModulesRunBeforeMainModule() {
    const defaults = originalGetModules();
    return [...defaults, path.resolve(projectRoot, "src/crypto-polyfill.ts")];
  },
};

// ---------------------------------------------------------------------------
// Resolver configuration
// ---------------------------------------------------------------------------

const TCP_SHIM = path.resolve(
  projectRoot,
  "src/shims/react-native-tcp-socket.ts",
);

// Block the sibling workspace packages Metro must never pull into the app
// bundle: the backend (server-only code) and the shared-types raw TS source
// (consumed via its built dist). Layered ON TOP of Metro's default blockList,
// never replacing it.
const blockPath = (dir) => {
  const resolved = path.resolve(dir);
  return new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/.*`);
};

const defaultBlockList = config.resolver?.blockList;
const baseBlockList = Array.isArray(defaultBlockList)
  ? defaultBlockList
  : defaultBlockList
    ? [defaultBlockList]
    : [];

const originalResolveRequest = config.resolver?.resolveRequest;

config.resolver = {
  ...config.resolver,
  blockList: [
    ...baseBlockList,
    blockPath(path.join(monorepoRoot, "packages/backend")),
    blockPath(path.join(monorepoRoot, "packages/shared-types/src")),
  ],
  assetExts: [...(config.resolver?.assetExts ?? []), "wasm", "woff2"],
  resolveRequest(context, moduleName, platform) {
    // On web, replace react-native-tcp-socket with an empty shim
    // (TCP sockets are not available in browsers; Electron uses IPC instead)
    if (platform === "web" && moduleName === "react-native-tcp-socket") {
      return { type: "sourceFile", filePath: TCP_SHIM };
    }
    if (originalResolveRequest) {
      return originalResolveRequest(context, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

// NativeWind 5 (built on react-native-css) compiles both the app's own Tailwind
// classes and Bloom's — a single wrapper, no separate `withReactNativeCSS`.
module.exports = withNativeWind(config, {
  input: "./global.css",
  inlineRem: 16,
  inlineVariables: false,
});

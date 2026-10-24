const path = require('node:path');
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

const projectRoot = __dirname;

// The preset owns the monorepo watch folder and block list (backend, worktrees,
// caches, tests), symlink + package-exports resolution, the font/wasm asset
// extensions, NativeWind (`./global.css`, 1rem = 16px) and the complete
// `react-native` behind NativeWind's shim. `sharedTypesPackage` keeps Metro off
// `packages/shared-types/src`: like `contracts`, `sdk` and `pay`, that package is
// consumed from its build output, which the root `postinstall` produces.
const config = createOxyMetroConfig(projectRoot, {
  sharedTypesPackage: '@peable.to/shared-types',
});

// ---------------------------------------------------------------------------
// Crypto polyfill: inject before all other modules so globalThis.crypto
// is available when @noble/hashes captures it at import time.
// ---------------------------------------------------------------------------

const originalGetModules = config.serializer?.getModulesRunBeforeMainModule ?? (() => []);

config.serializer = {
  ...config.serializer,
  getModulesRunBeforeMainModule() {
    const defaults = originalGetModules();
    return [...defaults, path.resolve(projectRoot, 'src/crypto-polyfill.ts')];
  },
};

// ---------------------------------------------------------------------------
// On web, replace react-native-tcp-socket with an empty shim (TCP sockets are
// not available in browsers; Electron uses IPC instead). Every other request,
// `react-native` included, goes down to the preset's resolver unchanged.
// ---------------------------------------------------------------------------

const TCP_SHIM = path.resolve(projectRoot, 'src/shims/react-native-tcp-socket.ts');
const presetResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'react-native-tcp-socket') {
    return { type: 'sourceFile', filePath: TCP_SHIM };
  }
  return presetResolveRequest(context, moduleName, platform);
};

module.exports = config;

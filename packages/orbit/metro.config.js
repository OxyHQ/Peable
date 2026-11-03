const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

// The preset owns the monorepo watch folder and block list, symlink and
// package-exports resolution (Bloom's subpath exports), NativeWind
// (`./global.css`) and the font/wasm asset extensions. `sharedTypesPackage`
// keeps Metro off `packages/shared-types/src`: like `contracts` and `sdk`, that
// package is consumed from its build output, which the root `postinstall`
// produces.
module.exports = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@peable.to/shared-types',
});

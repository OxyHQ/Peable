module.exports = (api) => {
  api.cache(true);
  return {
    presets: [
      // NativeWind 5 drives className interop through the Metro transformer
      // (react-native-css), not a Babel jsx pragma — so no `jsxImportSource:
      // "nativewind"` and no `nativewind/babel` preset (both are NativeWind 4).
      ['babel-preset-expo', { unstable_transformImportMeta: true }],
    ],
    plugins: ['react-native-worklets/plugin'],
  };
};

// Dynamic Expo config: the app's identity by variant (Oxy dev/prod pattern, as in
// the wallet's packages/frontend/app.config.js).
//
// A development build sits next to the production app on the same device with
// its own applicationId/bundleId and name. Build it with `APP_VARIANT=development`;
// production is the default. Commons' and @oxy.so/services' caller allow-lists
// hold `to.peable.orbit` and `to.peable.orbit.dev`.
//
// Orbit is web first (orbit.peable.to) and is not released as a phone binary:
// the Android release workflow builds only the wallet. The base config lives in
// app.json; this file overrides only the identity fields.
module.exports = ({ config }) => {
  const IS_DEV = process.env.APP_VARIANT === 'development';
  const BASE_ID = 'to.peable.orbit';
  const APP_ID = IS_DEV ? `${BASE_ID}.dev` : BASE_ID;
  const APP_NAME = IS_DEV ? 'Orbit by Peable (Dev)' : 'Orbit by Peable';

  return {
    ...config,
    name: APP_NAME,
    ios: { ...config.ios, bundleIdentifier: APP_ID },
    android: { ...config.android, package: APP_ID },
  };
};

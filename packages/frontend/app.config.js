// Dynamic Expo config (Oxy dev/prod variant pattern — see Mention + create-oxy-app).
//
// A development build sits next to the production Peable app AND every other
// app on the device (FairWallet's `in.fairco.wallet` is a DIFFERENT app and is
// never touched) by giving the dev build a distinct applicationId + name.
// Build the dev variant with `APP_VARIANT=development`; production is default.
//
// The base config (plugins, scheme, icons, notifications, …) lives in app.json;
// this file reads it as `config` and only overrides the identity fields.
module.exports = ({ config }) => {
  const IS_DEV = process.env.APP_VARIANT === 'development';
  // Moved from `so.oxy.pay` with the Peable rebrand, which was free only because
  // nothing had shipped to a store yet. The bundle identifier IS the app's
  // identity in the App Store and Play Console — once published, changing it
  // ships a second, unrelated app rather than renaming the listing, with no
  // upgrade path for existing installs. Treat it as frozen after the first
  // release.
  //
  // The Oxy-family sharing ids do NOT move with it. On iOS the keychain group
  // `group.so.oxy.shared` (app.json entitlements) is how this app reads the
  // identity Commons writes. On Android Peable has its own UID and asks Commons
  // over signature-protected IPC (`so.oxy.permission.IDENTITY`, declared by
  // `@oxy.so/services/plugins/withOxySharedPermissions`); Commons allow-lists
  // `to.peable.app` / `to.peable.app.dev` by package name, so renaming either
  // side cuts Peable out of the shared identity.
  const BASE_ID = 'to.peable.app';
  const APP_ID = IS_DEV ? `${BASE_ID}.dev` : BASE_ID;
  const APP_NAME = IS_DEV ? 'Peable (Dev)' : 'Peable';

  return {
    ...config,
    name: APP_NAME,
    ios: { ...config.ios, bundleIdentifier: APP_ID },
    android: { ...config.android, package: APP_ID },
  };
};

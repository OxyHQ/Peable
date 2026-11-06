// Dynamic Expo config (Oxy dev/prod variant pattern — see Mention + create-oxy-app).
//
// A development build sits next to the production Peable app AND every other
// app on the device (FairWallet's `in.fairco.wallet` is a DIFFERENT app and is
// never touched) by giving the dev build a distinct applicationId + name.
// Build the dev variant with `APP_VARIANT=development`; production is default.
//
// The base config (plugins, scheme, icons, notifications, …) lives in app.json;
// this file reads it as `config` and overrides only the identity fields and the
// development-only Noxcturnal flag (it depends on NODE_ENV, which JSON cannot read).
const {
  keychainEntries,
  keychainGroupsFor,
} = require('@oxy.so/app-preset/plugin/oxyKeychainGroups');

module.exports = ({ config }) => {
  const IS_DEV = process.env.APP_VARIANT === 'development';
  // Moved from `so.oxy.pay` with the Peable rebrand, which was free only because
  // nothing had shipped to a store yet. The bundle identifier IS the app's
  // identity in the App Store and Play Console — once published, changing it
  // ships a second, unrelated app rather than renaming the listing, with no
  // upgrade path for existing installs. Treat it as frozen after the first
  // release.
  //
  // The Oxy-family sharing ids do NOT move with it. On iOS the keychain groups
  // (`keychain-access-groups` below, from @oxy.so/app-preset's own table so they
  // cannot be spelled twice) are the wallet group FIRST — the group only Commons
  // and this wallet hold, where Commons keeps the keys the wallet signs with; it
  // is the default group, which tells @oxy.so/core this binary is the wallet —
  // then `group.so.oxy.shared` (public keys, the device session). Production
  // `to.peable.app` lists `so.oxy.wallet`; the dev build `to.peable.app.dev`
  // lists `so.oxy.wallet.dev`, so a dev build beside the production app on one
  // phone never reads production keys. The app's own items live in its own
  // group (`<TEAM>.<bundle id>`), which needs no entry. @oxy.so/app-preset
  // refuses any other layout for these bundle ids, and either restricted group
  // for any other app (oxy ADR 0062); since 6.4.0 the list must be EXACTLY
  // this one, in order, and oxy's shared release workflow (android-release.yml,
  // which this repo's release calls) prebuilds iOS on every native release and
  // runs `oxy-check-keychain-entitlements <bundle id> ios` over it. On Android Peable has its own UID and asks Commons
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
    experiments: {
      ...config.experiments,
      // Expo's oxc transformer, about 2x faster cold bundles than Babel. Development
      // only: in a production export it keeps the requires of dead platform branches
      // (`if (Platform.OS !== 'web') require(...)`), pulling native-only packages into
      // the web bundle. The CLI sets NODE_ENV before it reads this config.
      noxcturnalTransformWorker: process.env.NODE_ENV !== 'production',
    },
    ios: {
      ...config.ios,
      bundleIdentifier: APP_ID,
      entitlements: {
        ...config.ios?.entitlements,
        'keychain-access-groups': keychainEntries(keychainGroupsFor(APP_ID)),
      },
    },
    android: { ...config.android, package: APP_ID },
  };
};

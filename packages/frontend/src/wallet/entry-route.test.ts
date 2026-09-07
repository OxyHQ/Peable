import { describe, test, expect } from "bun:test";
import { decideEntryRoute } from "./entry-route";

describe("decideEntryRoute", () => {
  test("waits while auth is unresolved", () => {
    expect(decideEntryRoute({ isAuthResolved: false, isAuthenticated: false, identityInit: null, hasPinConfigured: null }).kind).toBe("loading");
  });

  test("signed out → sign in with Oxy", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: false, identityInit: null, hasPinConfigured: null }).kind).toBe("signin");
  });

  test("signed in, identity init pending → loading", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: null, hasPinConfigured: null }).kind).toBe("loading");
  });

  // An unrecognised `identityInit` falls through to "loading", so a rename that
  // changed the probe result and the route together would go green while the
  // screen hung forever. This asserts the exact pair the store actually emits.
  test("signed in with no keystore → the read-only surface", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: "no-keystore", hasPinConfigured: null }).kind).toBe("read-only");
  });

  /**
   * The rename this replaces was not cosmetic. `"web-unsupported"` named the
   * PLATFORM, and the entry screen acted on it by redirecting away — which sent
   * the browser to a screen whose back arrow fell through to `(tabs)`, the very
   * wallet the branch exists to say is impossible. What is actually absent is
   * the on-device keystore the identity seed derives from; everything a browser
   * CAN do (balance, history, receiving) needs no key at all.
   */
  test("the retired platform-shaped name no longer routes anywhere", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: "web-unsupported" as never, hasPinConfigured: null }).kind).toBe("loading");
  });

  test("signed in, keyless account → create Oxy ID", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: "no-identity", hasPinConfigured: null }).kind).toBe("create-identity");
  });

  test("wallet ready, PIN state unknown → loading", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: "initialized", hasPinConfigured: null }).kind).toBe("loading");
  });

  test("wallet ready, no PIN yet → needs PIN setup", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: "initialized", hasPinConfigured: false }).kind).toBe("needs-pin");
  });

  test("wallet ready, PIN set → ready", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: "initialized", hasPinConfigured: true }).kind).toBe("ready");
  });
});

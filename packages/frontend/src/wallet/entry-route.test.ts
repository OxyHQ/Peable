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
  test("signed in, no device has published a key → link this browser", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: "no-published-key", hasPinConfigured: null }).kind).toBe("link-device");
  });

  /**
   * The web build is NOT a separate kind of surface. Once a signing device has
   * published its account xpub, `initializeFromIdentity` returns "initialized"
   * on web exactly as it does on the phone, and the browser goes to the same
   * tabs through the same PIN gate. The names this replaces (`web-unsupported`,
   * `no-keystore`) both described a host rather than a missing input, and the
   * screen acted on them by rendering somewhere else.
   */
  test("web with a published key is just an initialized wallet", () => {
    expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: "initialized", hasPinConfigured: true }).kind).toBe("ready");
  });

  test("the retired host-shaped names no longer route anywhere", () => {
    for (const retired of ["web-unsupported", "no-keystore"]) {
      expect(decideEntryRoute({ isAuthResolved: true, isAuthenticated: true, identityInit: retired as never, hasPinConfigured: null }).kind).toBe("loading");
    }
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

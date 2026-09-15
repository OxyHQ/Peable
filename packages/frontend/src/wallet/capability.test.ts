import { describe, test, expect } from "bun:test";
import { decideWalletCapability } from "./capability";

const base = {
  walletInitialized: false,
  hasIdentityKeystore: false,
  isAuthResolved: true,
  isAuthenticated: true,
};

describe("decideWalletCapability", () => {
  test("an initialized wallet is full, on any host", () => {
    expect(decideWalletCapability({ ...base, walletInitialized: true })).toBe("full");
    expect(decideWalletCapability({ ...base, walletInitialized: true, hasIdentityKeystore: true })).toBe("full");
  });

  test("signed in with no keystore → read-only", () => {
    expect(decideWalletCapability(base)).toBe("read-only");
  });

  // The shell must never open for a keystore host that skipped the entry
  // screen: that is a wallet UI with no wallet behind it.
  test("a keystore host with no wallet yet is none, even when signed in", () => {
    expect(decideWalletCapability({ ...base, hasIdentityKeystore: true })).toBe("none");
  });

  test("keyless and signed out → none", () => {
    expect(decideWalletCapability({ ...base, isAuthenticated: false })).toBe("none");
  });

  // A reload on `/settings` starts with auth unresolved; answering `none`
  // there would bounce the deep link to `/` before auth could say read-only.
  test("keyless with auth unresolved → pending", () => {
    expect(decideWalletCapability({ ...base, isAuthResolved: false, isAuthenticated: false })).toBe("pending");
  });
});

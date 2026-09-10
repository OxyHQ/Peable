import { test, expect } from "bun:test";
import { SOCIAL_PAY_NETWORK } from "./social-network";
import {
  parseProfileHandle,
  decideProfilePayAction,
  buildProfileUrl,
} from "./profile-route";

test("reads the handle out of an @-prefixed segment", () => {
  expect(parseProfileHandle("@john")).toBe("john");
  expect(parseProfileHandle("@Nate_99")).toBe("Nate_99");
  expect(parseProfileHandle("@a-b-c")).toBe("a-b-c");
});

test("rejects every single-segment path that is not an @handle", () => {
  // This route is the app's catch-all for unknown one-segment URLs, so each of
  // these must 404 locally instead of asking Oxy about a user by that name.
  for (const segment of ["chain", "typo", "", "@", "@ab", "john"]) {
    expect(parseProfileHandle(segment)).toBeNull();
  }
});

test("rejects handles Oxy itself could never issue", () => {
  expect(parseProfileHandle(`@${"x".repeat(31)}`)).toBeNull();
  expect(parseProfileHandle("@has space")).toBeNull();
  expect(parseProfileHandle("@has/slash")).toBeNull();
  expect(parseProfileHandle("@emoji😀name")).toBeNull();
});

test("handles a missing or repeated segment", () => {
  expect(parseProfileHandle(undefined)).toBeNull();
  // expo-router hands a repeated param through as an array.
  expect(parseProfileHandle(["@john", "@jane"])).toBe("john");
  expect(parseProfileHandle([])).toBeNull();
});

const READY = {
  isWeb: false,
  isAuthResolved: true,
  isAuthenticated: true,
  isSelf: false,
  walletInitialized: true,
  network: "testnet",
} as const;

test("offers the send action only when every precondition holds", () => {
  expect(decideProfilePayAction(READY)).toEqual({ kind: "send" });
});

test("web never reaches the send action, signed in or not", () => {
  // The wallet seed derives from an on-device key a browser cannot hold, so
  // signing in changes nothing — a browser visitor is never asked to.
  expect(decideProfilePayAction({ ...READY, isWeb: true })).toEqual({ kind: "web" });
  expect(
    decideProfilePayAction({
      ...READY,
      isWeb: true,
      isAuthenticated: false,
      walletInitialized: false,
    }),
  ).toEqual({ kind: "web" });
});

test("never offers to pay yourself — the gateway rejects it with a 422", () => {
  expect(decideProfilePayAction({ ...READY, isSelf: true })).toEqual({ kind: "self" });
  // True in a browser too, where no wallet could exist.
  expect(decideProfilePayAction({ ...READY, isSelf: true, isWeb: true })).toEqual({
    kind: "self",
  });
  // …and on mainnet, where the send action is blocked for a different reason.
  expect(
    decideProfilePayAction({ ...READY, isSelf: true, network: "mainnet" }),
  ).toEqual({ kind: "self" });
});

test("a signed-out viewer is never 'self', whatever the id comparison says", () => {
  expect(
    decideProfilePayAction({ ...READY, isAuthenticated: false, isSelf: true }),
  ).toEqual({ kind: "signin" });
});

test("waits for Oxy auth to resolve before showing a CTA", () => {
  expect(
    decideProfilePayAction({ ...READY, isAuthResolved: false, isAuthenticated: false }),
  ).toEqual({ kind: "loading" });
});

test("asks a signed-out native payer to sign in", () => {
  expect(decideProfilePayAction({ ...READY, isAuthenticated: false })).toEqual({
    kind: "signin",
  });
});

test("reports a signed-in payer with no derived wallet", () => {
  expect(decideProfilePayAction({ ...READY, walletInitialized: false })).toEqual({
    kind: "wallet-not-ready",
  });
});

test("blocks the send action on mainnet (finding F-1)", () => {
  // Pay-by-@username has not cleared mainnet: an Oxy identity key rotation
  // desyncs the shared key slot and the payer sends to addresses the recipient
  // can neither see nor spend. The page must not offer it there.
  expect(decideProfilePayAction({ ...READY, network: "mainnet" })).toEqual({
    kind: "mainnet-blocked",
  });
});

/**
 * The gate and the read-only history must name the SAME network.
 *
 * They did not: this gate hard-coded `"testnet"` while `ReadOnlyWalletView`
 * took the wallet store's network — which on web is the store's DEFAULT
 * (`mainnet`), because no wallet initializes on that surface at all. So the app
 * could only create social payments on one network and only ever asked about
 * the other, and every web visitor saw an empty history that looked exactly
 * like never having been paid. Nothing errored and nothing logged.
 *
 * Both now read `SOCIAL_PAY_NETWORK`, and this is what keeps that true: the
 * gate must permit sending on precisely the network the history is read from.
 */
test("permits sending on exactly the network the read-only history asks about", () => {
  expect(decideProfilePayAction({ ...READY, network: SOCIAL_PAY_NETWORK })).toEqual({
    kind: "send",
  });
});

test("a signed-out mainnet wallet still reads as sign-in, not a network warning", () => {
  expect(
    decideProfilePayAction({ ...READY, network: "mainnet", isAuthenticated: false }),
  ).toEqual({ kind: "signin" });
});

test("builds the shareable profile link from the bare handle", () => {
  expect(buildProfileUrl("john")).toBe("https://peable.to/@john");
  expect(buildProfileUrl("Nate_99")).toBe("https://peable.to/@Nate_99");
});

test("round-trips with parseProfileHandle", () => {
  // The two are the only places that know the URL shape, so what one builds
  // the other must read back — otherwise a scanned QR lands on a 404.
  const handle = "john";
  const path = new URL(buildProfileUrl(handle)).pathname.slice(1);
  expect(parseProfileHandle(path)).toBe(handle);
});

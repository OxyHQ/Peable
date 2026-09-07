import { test, expect } from "bun:test";
import { buildFairCoinURI } from "@fairco.in/core";
import { parseScannedData } from "./scanned-code";

const ID = "pi_0123456789abcdef01234567";
const SECRET = "pi_0123456789abcdef01234567_secret_abcd";
const ADDR = "TC8KNvRhFUJUepcCSjBBeLa5HYo4Na11w3";
const MAINNET_ADDR = "F7PMPsihmKv8DGRWFykJwQ1ewMdp9hEH5T";

test("reads the QR that checkout.peable.to actually renders", () => {
  // This is the exact shape `packages/checkout/src/lib/deepLink.ts` builds.
  // Before this, the wallet's camera returned null for it and the flagship
  // desktop-checkout → scan-with-phone flow simply did not work.
  const uri = `peable://pay?intent=${ID}&secret=${encodeURIComponent(
    SECRET,
  )}&address=${ADDR}&amount=150000000&network=testnet`;

  const code = parseScannedData(uri);

  expect(code?.kind).toBe("payment-request");
  if (code?.kind !== "payment-request") throw new Error("unreachable");
  expect(code.request.intentId).toBe(ID);
  expect(code.request.clientSecret).toBe(SECRET);
  expect(code.request.address).toBe(ADDR);
  expect(code.request.amount).toBe(150000000n);
  expect(code.request.network).toBe("testnet");
});

test("a faircoin: URI keeps its amount", () => {
  // The hand-rolled parser this replaced split on '?' and threw the amount
  // away, so a merchant's requested amount never reached the send form.
  const code = parseScannedData(buildFairCoinURI(MAINNET_ADDR, "10.5"));

  expect(code).toEqual({ kind: "address", address: MAINNET_ADDR, amount: "10.5" });
});

test("a bare faircoin: URI carries no amount", () => {
  const code = parseScannedData(buildFairCoinURI(MAINNET_ADDR));

  expect(code).toEqual({ kind: "address", address: MAINNET_ADDR });
});

test("a raw address is still an address, mainnet and testnet", () => {
  expect(parseScannedData(MAINNET_ADDR)).toEqual({
    kind: "address",
    address: MAINNET_ADDR,
  });
  expect(parseScannedData(ADDR)).toEqual({ kind: "address", address: ADDR });
});

test("surrounding whitespace is tolerated", () => {
  expect(parseScannedData(`  ${ADDR}\n`)).toEqual({ kind: "address", address: ADDR });
});

test("a malformed payment request is not silently downgraded to an address", () => {
  // No `secret`: `parsePaymentRequest` rejects it. It must NOT then fall
  // through and be read as a bare address — that would push the send form with
  // a merchant's one-shot receive address and no way to report the txid.
  const uri = `peable://pay?intent=${ID}&address=${ADDR}&amount=1&network=testnet`;

  expect(parseScannedData(uri)).toBeNull();
});

test("unrelated codes are rejected", () => {
  expect(parseScannedData("https://peable.to/@nate")).toBeNull();
  expect(parseScannedData("")).toBeNull();
  expect(parseScannedData("bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBeNull();
});

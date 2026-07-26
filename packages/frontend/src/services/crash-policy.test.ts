/**
 * Tests for crash-log redaction and trimming (`crash-policy.ts`).
 *
 * The crash log is stored in ordinary (unencrypted) key-value storage and is
 * meant to be readable and shareable, so the redaction pass is a security
 * control, not cosmetics: an error thrown while a mnemonic, WIF or xprv was in
 * scope can quote that value in its message or a stack frame. These tests pin
 * both directions — secrets never survive, ordinary diagnostic text does.
 */

import { describe, test, expect } from "bun:test";
import {
  redactSecrets,
  toCrashEntry,
  appendCrashEntry,
  MAX_CRASH_ENTRIES,
  type CrashEntry,
} from "./crash-policy";

const MNEMONIC =
  "abandon ability able about above absent absorb abstract absurd abuse access accident";

describe("redactSecrets", () => {
  test("removes a 12-word BIP39 mnemonic", () => {
    const redacted = redactSecrets(`failed to restore: ${MNEMONIC}`);
    expect(redacted).not.toContain("abandon");
    expect(redacted).not.toContain("accident");
    expect(redacted).toContain("[redacted]");
  });

  test("removes a 24-word mnemonic", () => {
    const twentyFour = `${MNEMONIC} ${MNEMONIC}`;
    const redacted = redactSecrets(twentyFour);
    expect(redacted).not.toContain("abandon");
  });

  test("removes 64+ char hex (raw keys and seeds)", () => {
    const key = "a".repeat(64);
    expect(redactSecrets(`key=${key}`)).toBe("key=[redacted]");
    const seed = "0123456789abcdef".repeat(8);
    expect(redactSecrets(seed)).toBe("[redacted]");
  });

  test("removes extended private keys", () => {
    const xprv = `xprv${"9".repeat(40)}`;
    expect(redactSecrets(`derive ${xprv} failed`)).not.toContain(xprv);
  });

  test("removes WIF-length base58 strings", () => {
    const wif = `7${"K".repeat(50)}`;
    expect(wif).toHaveLength(51);
    expect(redactSecrets(wif)).toBe("[redacted]");
  });

  test("keeps ordinary error prose intact", () => {
    const message =
      "Failed to process transaction: peer disconnected before verack";
    expect(redactSecrets(message)).toBe(message);
  });

  test("keeps a FairCoin address intact (too short to be a WIF)", () => {
    const message = "no UTXOs for FHWtVW2d43aBcDeFgHjKmNpQrStUvWxYz";
    expect(redactSecrets(message)).toBe(message);
  });
});

describe("toCrashEntry", () => {
  test("captures name, message and stack, redacted", () => {
    const error = new TypeError(`bad seed ${MNEMONIC}`);
    const entry = toCrashEntry(error, true, 1_700_000_000);

    expect(entry.name).toBe("TypeError");
    expect(entry.at).toBe(1_700_000_000);
    expect(entry.fatal).toBe(true);
    expect(entry.message).not.toContain("abandon");
    expect(entry.stack).not.toContain("abandon");
  });

  test("handles a thrown non-Error value", () => {
    const entry = toCrashEntry("plain string failure", false, 42);
    expect(entry.name).toBe("string");
    expect(entry.message).toBe("plain string failure");
    expect(entry.stack).toBe("");
    expect(entry.fatal).toBe(false);
  });
});

describe("appendCrashEntry", () => {
  const entry = (at: number): CrashEntry => ({
    at,
    name: "Error",
    message: `boom ${at}`,
    stack: "",
    fatal: false,
  });

  test("appends in order", () => {
    const result = appendCrashEntry([entry(1)], entry(2));
    expect(result.map((e) => e.at)).toEqual([1, 2]);
  });

  test("drops the oldest past the cap", () => {
    const full = Array.from({ length: MAX_CRASH_ENTRIES }, (_, i) =>
      entry(i + 1),
    );
    const result = appendCrashEntry(full, entry(999));

    expect(result).toHaveLength(MAX_CRASH_ENTRIES);
    expect(result[0].at).toBe(2);
    expect(result[result.length - 1].at).toBe(999);
  });
});

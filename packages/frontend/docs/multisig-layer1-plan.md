# Layer 1: Generic m-of-n Multisig Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add generic m-of-n P2SH multisig primitives to `@fairco.in/core` (redeem-script/address construction, BIP16-correct partial signing, a cross-device signature-exchange format, and P2SH-aware transaction building), then wire a minimal consuming path into FAIRWallet (watch-address registration + build/sign/combine/finalize a spend). This is the upstream capability layer — Oxy Pay's "Shared Pockets" feature (multi-party spend coordination, UX, notifications) is a separate, later effort that builds ON TOP of what this plan ships.

**Architecture:** `@fairco.in/core` gets three new modules that mirror its existing single-key primitives one level up: `multisig-script.ts` (redeem script + address, parallel to `address.ts`/`script.ts`), `multisig-sign.ts` (BIP16 sighash + bare-signature signing + scriptSig assembly + a minimal signing-request exchange format, parallel to `signInput` in `transaction.ts`), and `multisig-transaction.ts` (multisig-aware fee estimation + spend building, parallel to `buildTransaction`). `transaction.ts`'s existing `buildTransaction` also becomes P2SH-aware on its OUTPUT side (via a new shared `scriptForAddress` helper in `script.ts`) so a normal single-key send can pay INTO a multisig address — that bug exists today and is fixed as part of this plan. FAIRWallet consumes the published package additively: `KeyManager` gains a non-HD "watch address" registration path (a multisig address is not BIP44-derived, so `ownsAddress`/the Bloom filter would otherwise never see it), and a new `src/wallet/multisig.ts` wraps the library's spend-building/signing/combining primitives into a thin, pure orchestration layer that never touches a private key it wasn't explicitly handed by its caller.

**Tech Stack:** TypeScript (strict), bun + `bun:test`, `@noble/secp256k1` v2 (already pinned, deterministic RFC6979 signing), `@noble/hashes`, `bs58`. No new dependencies.

## Global Constraints

- Self-custody: private keys never leave the signer's device. No function added by this plan returns, logs, or serializes a private key — verified per-task with an explicit test where noted. Multisig coordination relays only `PartialSignature` (pubkey + DER signature) or the `SerializedMultisigSigningRequest` (unsigned tx + input index + redeem script), never key material.
- Every signing/script-crypto task uses REAL, independently-reproducible test vectors: derived by actually running the target algorithm through this package's own pinned `@noble/secp256k1` (deterministic RFC6979 — same private key + message always produces the same signature, so the hex below is reproducible by anyone re-running the same code), not hand-typed or invented hex. Every hex constant in this plan was computed and cross-checked (round-trip serialize/deserialize, `hashTransaction`, `extractAddressFromScript`) before being written down.
- `@fairco.in/core` is a published library (currently v0.1.1). Every change in Tasks 1–5 is ADDITIVE — no existing exported signature changes. The version bump in Task 6 is MINOR (0.1.1 → 0.2.0).
- bun only (`bun test`, `bun install`, `bun publish` — never npm/yarn/npx). No `as any`, `@ts-ignore`, `@ts-expect-error`, `!` non-null assertions, `console.log` in shipped code, silent `catch {}`, or TODO/FIXME comments. TypeScript strict mode. No unnecessary abstractions — shared logic (e.g. DER signature encoding) is exported and reused, never copy-pasted.
- A `security-reviewer` audit (Task 10) is a MANDATORY gate before any real-money use of this code. This plan proves the CRYPTO is byte-correct against real vectors; it does NOT prove FairCoin Core's node/consensus rules accept standard BIP16 P2SH + BIP11 CHECKMULTISIG scripts as relay-standard — that needs a live testnet probe, flagged explicitly in Task 10.

---

## File Structure

**`/home/nate/faircoin-core/`** (published as `@fairco.in/core`, currently v0.1.1) — pure-lib, testable immediately, no publish needed to test:

- `src/multisig-script.ts` (NEW, Task 1) — `createMultisigRedeemScript`, `multisigAddress`: redeem script construction and its P2SH address, mirroring `address.ts`.
- `src/script.ts` (MODIFY, Task 4) — adds `scriptForAddress`: dispatches to `createP2PKHScript`/`createP2SHScript` by decoding the address's version byte.
- `src/transaction.ts` (MODIFY, Task 2 exports `derEncodeSignature` for reuse; Task 4 makes `buildTransaction`'s outputs P2SH-aware) — no breaking changes, both are additive/internal.
- `src/multisig-sign.ts` (NEW Task 2, MODIFY Task 3) — `computeMultisigSigHash`, `signMultisigInput` (Task 2); `PartialSignature`, `assembleMultisigScriptSig`, `MultisigSigningRequest`/`SerializedMultisigSigningRequest` + serialize/deserialize (Task 3).
- `src/multisig-transaction.ts` (NEW, Task 5) — `estimateMultisigInputSize`, `estimateMultisigTxSize`, `buildMultisigSpend`: P2SH-multisig-aware fee estimation and spend building.
- `src/index.ts` (MODIFY, Task 6) — public export surface for everything above.
- `package.json` (MODIFY, Task 6) — version bump.
- `test/multisig-script.test.ts` (NEW, Task 1)
- `test/multisig-sign.test.ts` (NEW Task 2, MODIFY Task 3)
- `test/transaction.test.ts` (MODIFY, Task 4)
- `test/multisig-transaction.test.ts` (NEW, Task 5)

**`/home/nate/FairCoinWorkspace/FAIRWallet/`** (consumes `@fairco.in/core`) — FAIRWallet-app, needs Task 6 published first:

- `package.json` (MODIFY, Task 7) — bump `@fairco.in/core` dependency.
- `src/storage/database.ts` (MODIFY, Task 8) — new `watch_addresses` table + `insertWatchAddress`/`getWatchAddresses` (thin SQL, consistent with the rest of this file — not unit-tested directly, same as every other DB accessor here; `expo-sqlite` is a native module the repo does not exercise under plain `bun test`).
- `src/wallet/key-manager.ts` (MODIFY, Task 8) — `registerWatchAddress`/`getWatchAddresses`, `ownsAddress` and `getAllAddresses` include watch addresses, `wipe()` clears them.
- `src/wallet/key-manager.test.ts` (MODIFY, Task 8)
- `src/wallet/multisig.ts` (NEW Task 8: watch-registration glue; MODIFY Task 9: spend build/sign/combine/finalize) — the "minimal multisig-wallet path", pure except for the two thin DB-glue functions.
- `src/wallet/multisig.test.ts` (NEW, Task 9)
- `src/wallet/wallet-store.ts` (MODIFY, Task 8 — two-line wiring, no new test; mirrors the existing `restoreCursors` wiring pattern already in this file)

---

## Task 1: `createMultisigRedeemScript` + `multisigAddress` (pure lib — feasibility A)

**Files:**
- Create: `/home/nate/faircoin-core/src/multisig-script.ts`
- Create: `/home/nate/faircoin-core/test/multisig-script.test.ts`

**Interfaces:**
- Consumes: `Opcodes`, `pushData` from `src/script.ts`; `hash160` from `src/address.ts`; `encodeAddress` from `src/encoding.ts`; `type NetworkConfig` from `src/network.ts`.
- Produces: `createMultisigRedeemScript(m: number, pubkeys: Uint8Array[]): Uint8Array`, `multisigAddress(redeemScript: Uint8Array, network: NetworkConfig): string`. Every later task imports both from `./multisig-script.js`.

- [ ] **Step 1: Write the failing test**

Create `/home/nate/faircoin-core/test/multisig-script.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";

import { hexToBytes, bytesToHex } from "../src/encoding.js";
import { MAINNET, TESTNET } from "../src/network.js";
import { createMultisigRedeemScript, multisigAddress } from "../src/multisig-script.js";

// Fixed, reproducible secp256k1 compressed public keys, derived from private
// keys 0x01/0x02/0x03 repeated to 32 bytes via @noble/secp256k1 (this
// package's own pinned signing library). Reused across multisig-sign.test.ts
// and multisig-transaction.test.ts so every test in this plan is internally
// consistent.
const PUB1 = hexToBytes("031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f");
const PUB2 = hexToBytes("024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766");
const PUB3 = hexToBytes("02531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337");

describe("createMultisigRedeemScript", () => {
  test("2-of-3 produces the exact real redeem script bytes", () => {
    const script = createMultisigRedeemScript(2, [PUB1, PUB2, PUB3]);
    expect(bytesToHex(script)).toBe(
      "5221031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f21024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d07662102531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe33753ae",
    );
    expect(script.length).toBe(105);
  });

  test("1-of-1 (smallest multisig)", () => {
    const script = createMultisigRedeemScript(1, [PUB1]);
    expect(bytesToHex(script)).toBe(
      "5121031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f51ae",
    );
  });

  test("rejects m > n", () => {
    expect(() => createMultisigRedeemScript(3, [PUB1, PUB2])).toThrow(/cannot exceed n/);
  });

  test("rejects m < 1", () => {
    expect(() => createMultisigRedeemScript(0, [PUB1])).toThrow(/positive integer/);
  });

  test("rejects more than 16 pubkeys (OP_1..OP_16 opcode ceiling)", () => {
    const seventeen = Array.from({ length: 17 }, () => PUB1);
    expect(() => createMultisigRedeemScript(1, seventeen)).toThrow(/between 1 and 16/);
  });

  test("rejects a redeem script over the 520-byte standard relay limit", () => {
    const sixteen = Array.from({ length: 16 }, () => PUB1);
    expect(() => createMultisigRedeemScript(16, sixteen)).toThrow(/520-byte/);
  });

  test("rejects an invalid public key length", () => {
    expect(() => createMultisigRedeemScript(1, [new Uint8Array(20)])).toThrow(
      /Invalid public key length/,
    );
  });
});

describe("multisigAddress", () => {
  test("produces the real mainnet 2-of-3 P2SH address", () => {
    const script = createMultisigRedeemScript(2, [PUB1, PUB2, PUB3]);
    expect(multisigAddress(script, MAINNET)).toBe("7iKBxUNbBbTa8n1Q32oLucmvmKL7c572P2");
  });

  test("produces the real testnet 2-of-3 P2SH address", () => {
    const script = createMultisigRedeemScript(2, [PUB1, PUB2, PUB3]);
    expect(multisigAddress(script, TESTNET)).toBe("66xn23BSLsc4s3T3wMU4y7gnFJJLmXkhhT");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/nate/faircoin-core && bun test test/multisig-script.test.ts`
Expected: FAIL — `Cannot find module '../src/multisig-script.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `/home/nate/faircoin-core/src/multisig-script.ts`:

```typescript
/**
 * Generic m-of-n P2SH multisig redeem script construction and addressing.
 *
 * Mirrors address.ts/script.ts one level up: a "redeem script" here is what
 * a P2PKH scriptPubKey is there — the thing that gets hashed into an
 * address, except a multisig address requires the actual script (not just a
 * pubkey) to spend from, since OP_CHECKMULTISIG needs it on the stack.
 */
import { hash160 } from "./address.js";
import { encodeAddress } from "./encoding.js";
import type { NetworkConfig } from "./network.js";
import { Opcodes, pushData } from "./script.js";

/** Hard ceiling: only OP_1..OP_16 exist, so no more than 16 keys can be encoded. */
const MAX_PUBKEYS = 16;

/**
 * Bitcoin's standard-relay ceiling for a P2SH redeem script (MAX_SCRIPT_ELEMENT_SIZE).
 * A larger script is consensus-valid but non-standard: most nodes won't relay
 * or mine a spend from it, so a wallet must never construct one.
 */
const MAX_STANDARD_REDEEM_SCRIPT_SIZE = 520;

function opN(n: number): number {
  return Opcodes.OP_1 + n - 1;
}

/**
 * Build a raw m-of-n multisig redeem script:
 * `OP_m <pubkey1> <pubkey2> ... <pubkeyN> OP_n OP_CHECKMULTISIG`.
 *
 * Pubkeys must be given in the exact order all cosigners agree on — that
 * order is baked into the script (and therefore the address) and is also
 * the order `assembleMultisigScriptSig` (multisig-sign.ts) requires
 * signatures to be presented in.
 */
export function createMultisigRedeemScript(m: number, pubkeys: Uint8Array[]): Uint8Array {
  const n = pubkeys.length;

  if (!Number.isInteger(m) || m < 1) {
    throw new Error(`Invalid multisig threshold m=${m}: must be a positive integer`);
  }
  if (n < 1 || n > MAX_PUBKEYS) {
    throw new Error(`Invalid multisig pubkey count n=${n}: must be between 1 and ${MAX_PUBKEYS}`);
  }
  if (m > n) {
    throw new Error(`Invalid multisig threshold: m=${m} cannot exceed n=${n}`);
  }
  for (const pubkey of pubkeys) {
    if (pubkey.length !== 33 && pubkey.length !== 65) {
      throw new Error(
        `Invalid public key length: expected 33 (compressed) or 65 (uncompressed), got ${pubkey.length}`,
      );
    }
  }

  const parts: Uint8Array[] = [new Uint8Array([opN(m)])];
  for (const pubkey of pubkeys) {
    parts.push(pushData(pubkey));
  }
  parts.push(new Uint8Array([opN(n)]));
  parts.push(new Uint8Array([Opcodes.OP_CHECKMULTISIG]));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (total > MAX_STANDARD_REDEEM_SCRIPT_SIZE) {
    throw new Error(
      `Redeem script is ${total} bytes, exceeding the ${MAX_STANDARD_REDEEM_SCRIPT_SIZE}-byte standard relay limit`,
    );
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Derive the P2SH address for a redeem script: `hash160(redeemScript)`
 * encoded with the network's script-hash version byte.
 */
export function multisigAddress(redeemScript: Uint8Array, network: NetworkConfig): string {
  return encodeAddress(hash160(redeemScript), network.scriptHash);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/nate/faircoin-core && bun test test/multisig-script.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `cd /home/nate/faircoin-core && bun run typecheck`
Expected: no errors.

```bash
cd /home/nate/faircoin-core
git add src/multisig-script.ts test/multisig-script.test.ts
git commit -m "feat(multisig): add createMultisigRedeemScript and multisigAddress"
```

---

## Task 2: BIP16 sighash + bare-signature signing (pure lib — feasibility B core)

**Files:**
- Modify: `/home/nate/faircoin-core/src/transaction.ts:232` (export `derEncodeSignature`)
- Create: `/home/nate/faircoin-core/src/multisig-sign.ts`
- Create: `/home/nate/faircoin-core/test/multisig-sign.test.ts`

**Interfaces:**
- Consumes: `serializeTransaction`, `derEncodeSignature`, `type Transaction`, `SIGHASH_ALL` from `src/transaction.ts`; `BufferWriter` from `src/encoding.ts`; `createMultisigRedeemScript` from Task 1.
- Produces: `computeMultisigSigHash(tx, inputIndex, redeemScript, hashType?): Uint8Array`, `signMultisigInput(tx, inputIndex, redeemScript, privateKey): Uint8Array` (a BARE DER signature + hashtype byte — NOT a finished scriptSig). Task 3 extends this same file; Task 9 (FAIRWallet) calls `signMultisigInput`.

- [ ] **Step 1: Export `derEncodeSignature` from transaction.ts (no behavior change)**

In `/home/nate/faircoin-core/src/transaction.ts:232`, change:

```typescript
function derEncodeSignature(r: bigint, s: bigint): Uint8Array {
```

to:

```typescript
export function derEncodeSignature(r: bigint, s: bigint): Uint8Array {
```

This is the only change to `transaction.ts` in this step — `signInput`'s behavior is unchanged (it already used this function locally; existing tests cover it). Do NOT add it to `src/index.ts`'s public export list — it stays an internal-to-the-package helper, reused by `multisig-sign.ts` via a direct file import, so multisig signing doesn't duplicate DER encoding.

- [ ] **Step 2: Write the failing test**

Create `/home/nate/faircoin-core/test/multisig-sign.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";

import { hexToBytes, bytesToHex } from "../src/encoding.js";
import { hash160 } from "../src/address.js";
import { createP2PKHScript } from "../src/script.js";
import type { Transaction } from "../src/transaction.js";
import { createMultisigRedeemScript } from "../src/multisig-script.js";
import { computeMultisigSigHash, signMultisigInput } from "../src/multisig-sign.js";

// Same fixed keys as multisig-script.test.ts.
const PUB1 = hexToBytes("031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f");
const PUB2 = hexToBytes("024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766");
const PUB3 = hexToBytes("02531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337");
const PRIV1 = hexToBytes("01".repeat(32));
const PRIV3 = hexToBytes("03".repeat(32));

export const REDEEM_SCRIPT = createMultisigRedeemScript(2, [PUB1, PUB2, PUB3]);

/** A synthetic 1-input, 1-output unsigned tx spending a fake P2SH UTXO. */
export function fixtureTx(): Transaction {
  return {
    version: 1,
    inputs: [
      {
        txid: "aa".repeat(32),
        vout: 0,
        scriptSig: new Uint8Array(0),
        sequence: 0xffffffff,
      },
    ],
    outputs: [
      {
        value: 4_900_000n,
        scriptPubKey: createP2PKHScript(hash160(PUB1)),
      },
    ],
    lockTime: 0,
  };
}

describe("computeMultisigSigHash", () => {
  test("matches the real, independently-reproducible sighash", () => {
    const sigHash = computeMultisigSigHash(fixtureTx(), 0, REDEEM_SCRIPT);
    expect(bytesToHex(sigHash)).toBe(
      "2c9a73c1356725b2cf6e3a49110767eeb75eb35016f3fe8c07d3f932231597b7",
    );
  });

  test("throws for an out-of-range input index", () => {
    expect(() => computeMultisigSigHash(fixtureTx(), 5, REDEEM_SCRIPT)).toThrow();
  });
});

describe("signMultisigInput", () => {
  test("signer 1 produces the real, deterministic (RFC6979) DER signature", () => {
    const sig = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1);
    expect(bytesToHex(sig)).toBe(
      "3045022100a75e0470f26695564c7d7532dad3aeac6845280a5a10f135b32525752c7bbbc4022045a7fd3af5b2776c6e23f13b30cdec93504942e00ee23e2dd2a2eff8497d629d01",
    );
    expect(sig[sig.length - 1]).toBe(0x01); // trailing SIGHASH_ALL byte
  });

  test("signer 3 produces a different, also-deterministic signature", () => {
    const sig = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV3);
    expect(bytesToHex(sig)).toBe(
      "3044022050837cdb7dafab46d59dc1385ae2716aedf2d0ff29ebfeebcfec4552da173ed002200fc8187898f3cc9fbde73fd781f93824820f21d4b30cc8859581788824175e7501",
    );
  });

  test("signing is deterministic: the same key + tx always produces the same signature", () => {
    const a = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1);
    const b = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  test("never returns anything resembling the private key (key-leak guard)", () => {
    const sig = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1);
    expect(bytesToHex(sig)).not.toContain(bytesToHex(PRIV1));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /home/nate/faircoin-core && bun test test/multisig-sign.test.ts`
Expected: FAIL — `Cannot find module '../src/multisig-sign.js'`.

- [ ] **Step 4: Write the implementation**

Create `/home/nate/faircoin-core/src/multisig-sign.ts`:

```typescript
/**
 * Multisig (P2SH) input signing for FairCoin transactions.
 *
 * Bitcoin's OP_CHECKMULTISIG requires the sighash for a P2SH multisig input
 * to be computed against the REDEEM SCRIPT (not the P2SH scriptPubKey) --
 * this is the BIP16 "scriptCode substitution" rule. `computeMultisigSigHash`
 * is the multisig analogue of the private `computeSigHash` in
 * transaction.ts; `signMultisigInput` returns a BARE DER signature (never a
 * finished scriptSig -- the P2SH scriptSig needs `m` of these from
 * different cosigners before it can be finalized, see
 * `assembleMultisigScriptSig` further down this file, added in Task 3).
 *
 * Importing from transaction.ts below also runs its module-level
 * `secp256k1.etc.hmacSha256Sync` configuration (deterministic RFC6979
 * signing) as a side effect of ES module evaluation -- that assignment
 * happens once, the first time transaction.ts is loaded, so it is not
 * repeated here.
 */
import { sha256 } from "@noble/hashes/sha256";
import * as secp256k1 from "@noble/secp256k1";
import { BufferWriter } from "./encoding.js";
import {
  serializeTransaction,
  derEncodeSignature,
  type Transaction,
  SIGHASH_ALL,
} from "./transaction.js";

/**
 * Compute the SIGHASH_ALL sighash for a P2SH multisig input: identical to
 * `signInput`'s algorithm, except the scriptCode substituted into the input
 * being signed is the REDEEM SCRIPT, per BIP16.
 */
export function computeMultisigSigHash(
  tx: Transaction,
  inputIndex: number,
  redeemScript: Uint8Array,
  hashType: number = SIGHASH_ALL,
): Uint8Array {
  if (inputIndex < 0 || inputIndex >= tx.inputs.length) {
    throw new Error(
      `Input index ${inputIndex} out of range [0, ${tx.inputs.length})`,
    );
  }

  const sigTx: Transaction = {
    version: tx.version,
    inputs: tx.inputs.map((input, idx) => ({
      txid: input.txid,
      vout: input.vout,
      scriptSig: idx === inputIndex ? redeemScript : new Uint8Array(0),
      sequence: input.sequence,
    })),
    outputs: tx.outputs.map((output) => ({
      value: output.value,
      scriptPubKey: output.scriptPubKey,
    })),
    lockTime: tx.lockTime,
  };

  const writer = new BufferWriter();
  writer.writeBytes(serializeTransaction(sigTx));
  writer.writeUInt32LE(hashType);

  return sha256(sha256(writer.toBytes()));
}

/**
 * Sign a P2SH multisig input with ONE private key. Returns a BARE DER
 * signature + SIGHASH_ALL byte -- NOT a finished scriptSig. The private key
 * never leaves this function's stack frame and is never part of the return
 * value; combine the returned signatures from `m` different cosigners with
 * `assembleMultisigScriptSig` (Task 3) to produce the final, broadcastable
 * scriptSig.
 */
export function signMultisigInput(
  tx: Transaction,
  inputIndex: number,
  redeemScript: Uint8Array,
  privateKey: Uint8Array,
): Uint8Array {
  const sigHash = computeMultisigSigHash(tx, inputIndex, redeemScript, SIGHASH_ALL);

  const signature = secp256k1.sign(sigHash, privateKey);
  const normalizedSig = signature.hasHighS() ? signature.normalizeS() : signature;
  const derSig = derEncodeSignature(normalizedSig.r, normalizedSig.s);

  const sigWithHashType = new Uint8Array(derSig.length + 1);
  sigWithHashType.set(derSig, 0);
  sigWithHashType[derSig.length] = SIGHASH_ALL;

  return sigWithHashType;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /home/nate/faircoin-core && bun test test/multisig-sign.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Full suite regression check, typecheck, and commit**

Run: `cd /home/nate/faircoin-core && bun test && bun run typecheck`
Expected: all existing tests still PASS (transaction.ts's only change was adding `export`), no type errors.

```bash
cd /home/nate/faircoin-core
git add src/transaction.ts src/multisig-sign.ts test/multisig-sign.test.ts
git commit -m "feat(multisig): add BIP16 sighash and bare-signature multisig signing"
```

---

## Task 3: scriptSig assembler + partial-signature exchange format (pure lib — feasibility B)

**Files:**
- Modify: `/home/nate/faircoin-core/src/multisig-sign.ts` (append)
- Modify: `/home/nate/faircoin-core/test/multisig-sign.test.ts` (append)

**Interfaces:**
- Consumes: `Opcodes`, `pushData` from `src/script.ts`; `bytesToHex`, `hexToBytes` from `src/encoding.ts`; `serializeTransaction`, `deserializeTransaction`, `type Transaction` from `src/transaction.ts`; everything from Task 2.
- Produces: `interface PartialSignature { pubkey, signature }`, `assembleMultisigScriptSig(signatures: PartialSignature[], redeemScript: Uint8Array): Uint8Array`, `interface MultisigSigningRequest { tx, inputIndex, redeemScript }`, `interface SerializedMultisigSigningRequest { txHex, inputIndex, redeemScriptHex }`, `serializeMultisigSigningRequest(request): SerializedMultisigSigningRequest`, `deserializeMultisigSigningRequest(serialized): MultisigSigningRequest`. Task 9 (FAIRWallet) imports all of these.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `/home/nate/faircoin-core/test/multisig-sign.test.ts` with (adds imports + two new `describe` blocks to the Task 2 file):

```typescript
import { describe, test, expect } from "bun:test";

import { hexToBytes, bytesToHex } from "../src/encoding.js";
import { hash160 } from "../src/address.js";
import { createP2PKHScript } from "../src/script.js";
import { serializeTransaction, type Transaction } from "../src/transaction.js";
import { createMultisigRedeemScript } from "../src/multisig-script.js";
import {
  computeMultisigSigHash,
  signMultisigInput,
  assembleMultisigScriptSig,
  serializeMultisigSigningRequest,
  deserializeMultisigSigningRequest,
  type PartialSignature,
  type MultisigSigningRequest,
} from "../src/multisig-sign.js";

// Same fixed keys as multisig-script.test.ts.
const PUB1 = hexToBytes("031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f");
const PUB2 = hexToBytes("024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766");
const PUB3 = hexToBytes("02531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337");
const PRIV1 = hexToBytes("01".repeat(32));
const PRIV3 = hexToBytes("03".repeat(32));

export const REDEEM_SCRIPT = createMultisigRedeemScript(2, [PUB1, PUB2, PUB3]);

/** A synthetic 1-input, 1-output unsigned tx spending a fake P2SH UTXO. */
export function fixtureTx(): Transaction {
  return {
    version: 1,
    inputs: [
      {
        txid: "aa".repeat(32),
        vout: 0,
        scriptSig: new Uint8Array(0),
        sequence: 0xffffffff,
      },
    ],
    outputs: [
      {
        value: 4_900_000n,
        scriptPubKey: createP2PKHScript(hash160(PUB1)),
      },
    ],
    lockTime: 0,
  };
}

describe("computeMultisigSigHash", () => {
  test("matches the real, independently-reproducible sighash", () => {
    const sigHash = computeMultisigSigHash(fixtureTx(), 0, REDEEM_SCRIPT);
    expect(bytesToHex(sigHash)).toBe(
      "2c9a73c1356725b2cf6e3a49110767eeb75eb35016f3fe8c07d3f932231597b7",
    );
  });

  test("throws for an out-of-range input index", () => {
    expect(() => computeMultisigSigHash(fixtureTx(), 5, REDEEM_SCRIPT)).toThrow();
  });
});

describe("signMultisigInput", () => {
  test("signer 1 produces the real, deterministic (RFC6979) DER signature", () => {
    const sig = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1);
    expect(bytesToHex(sig)).toBe(
      "3045022100a75e0470f26695564c7d7532dad3aeac6845280a5a10f135b32525752c7bbbc4022045a7fd3af5b2776c6e23f13b30cdec93504942e00ee23e2dd2a2eff8497d629d01",
    );
    expect(sig[sig.length - 1]).toBe(0x01);
  });

  test("signer 3 produces a different, also-deterministic signature", () => {
    const sig = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV3);
    expect(bytesToHex(sig)).toBe(
      "3044022050837cdb7dafab46d59dc1385ae2716aedf2d0ff29ebfeebcfec4552da173ed002200fc8187898f3cc9fbde73fd781f93824820f21d4b30cc8859581788824175e7501",
    );
  });

  test("signing is deterministic: the same key + tx always produces the same signature", () => {
    const a = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1);
    const b = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  test("never returns anything resembling the private key (key-leak guard)", () => {
    const sig = signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1);
    expect(bytesToHex(sig)).not.toContain(bytesToHex(PRIV1));
  });
});

describe("assembleMultisigScriptSig", () => {
  test("produces the exact real finalized scriptSig (signers 1 and 3, in order)", () => {
    const sig1: PartialSignature = {
      pubkey: PUB1,
      signature: signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1),
    };
    const sig3: PartialSignature = {
      pubkey: PUB3,
      signature: signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV3),
    };
    const scriptSig = assembleMultisigScriptSig([sig1, sig3], REDEEM_SCRIPT);
    expect(bytesToHex(scriptSig)).toBe(
      "00483045022100a75e0470f26695564c7d7532dad3aeac6845280a5a10f135b32525752c7bbbc4022045a7fd3af5b2776c6e23f13b30cdec93504942e00ee23e2dd2a2eff8497d629d01473044022050837cdb7dafab46d59dc1385ae2716aedf2d0ff29ebfeebcfec4552da173ed002200fc8187898f3cc9fbde73fd781f93824820f21d4b30cc8859581788824175e75014c695221031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f21024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d07662102531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe33753ae",
    );
    expect(scriptSig.length).toBe(253);
    expect(scriptSig[0]).toBe(0x00); // mandatory OP_0 CHECKMULTISIG dummy element
  });

  test("reorders signatures given in the WRONG order to match the redeem script's pubkey order", () => {
    const sig1: PartialSignature = {
      pubkey: PUB1,
      signature: signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1),
    };
    const sig3: PartialSignature = {
      pubkey: PUB3,
      signature: signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV3),
    };
    // Signer 3's signature passed FIRST -- the result must still put signer
    // 1 first, since PUB1 appears before PUB3 in the redeem script.
    const reversedOrder = assembleMultisigScriptSig([sig3, sig1], REDEEM_SCRIPT);
    const naturalOrder = assembleMultisigScriptSig([sig1, sig3], REDEEM_SCRIPT);
    expect(bytesToHex(reversedOrder)).toBe(bytesToHex(naturalOrder));
  });

  test("rejects a signature whose pubkey is not part of the redeem script", () => {
    const foreignSig: PartialSignature = {
      pubkey: hexToBytes("02".repeat(33)),
      signature: signMultisigInput(fixtureTx(), 0, REDEEM_SCRIPT, PRIV1),
    };
    expect(() => assembleMultisigScriptSig([foreignSig], REDEEM_SCRIPT)).toThrow(
      /not part of this redeem script/,
    );
  });
});

describe("serializeMultisigSigningRequest / deserializeMultisigSigningRequest", () => {
  test("round-trips through the real unsigned tx and matches the known wire hex", () => {
    const request: MultisigSigningRequest = {
      tx: fixtureTx(),
      inputIndex: 0,
      redeemScript: REDEEM_SCRIPT,
    };
    const serialized = serializeMultisigSigningRequest(request);
    expect(serialized.txHex).toBe(
      "0100000001aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000ffffffff01a0c44a00000000001976a91479b000887626b294a914501a4cd226b58b23598388ac00000000",
    );
    expect(serialized.inputIndex).toBe(0);
    expect(serialized.redeemScriptHex).toBe(bytesToHex(REDEEM_SCRIPT));

    const deserialized = deserializeMultisigSigningRequest(serialized);
    expect(bytesToHex(serializeTransaction(deserialized.tx))).toBe(
      bytesToHex(serializeTransaction(request.tx)),
    );
    expect(deserialized.inputIndex).toBe(0);
    expect(bytesToHex(deserialized.redeemScript)).toBe(bytesToHex(REDEEM_SCRIPT));
  });

  test("signing from a DESERIALIZED request matches signing the original directly", () => {
    const request: MultisigSigningRequest = {
      tx: fixtureTx(),
      inputIndex: 0,
      redeemScript: REDEEM_SCRIPT,
    };
    const roundTripped = deserializeMultisigSigningRequest(serializeMultisigSigningRequest(request));
    const sigFromOriginal = signMultisigInput(request.tx, request.inputIndex, request.redeemScript, PRIV1);
    const sigFromRoundTrip = signMultisigInput(
      roundTripped.tx,
      roundTripped.inputIndex,
      roundTripped.redeemScript,
      PRIV1,
    );
    expect(bytesToHex(sigFromRoundTrip)).toBe(bytesToHex(sigFromOriginal));
  });
});
```

- [ ] **Step 2: Run the test to verify the new blocks fail**

Run: `cd /home/nate/faircoin-core && bun test test/multisig-sign.test.ts`
Expected: FAIL — `assembleMultisigScriptSig`/`serializeMultisigSigningRequest`/`deserializeMultisigSigningRequest`/`PartialSignature`/`MultisigSigningRequest` are not exported yet.

- [ ] **Step 3: Append the implementation**

Update the import block at the top of `/home/nate/faircoin-core/src/multisig-sign.ts` to:

```typescript
import { sha256 } from "@noble/hashes/sha256";
import * as secp256k1 from "@noble/secp256k1";
import { bytesToHex, hexToBytes, BufferWriter } from "./encoding.js";
import { Opcodes, pushData } from "./script.js";
import {
  serializeTransaction,
  deserializeTransaction,
  derEncodeSignature,
  type Transaction,
  SIGHASH_ALL,
} from "./transaction.js";
```

Then append to the end of the file (after `signMultisigInput`):

```typescript
/**
 * Parse the pubkeys (in order) out of a redeem script built by
 * `createMultisigRedeemScript`. Used by `assembleMultisigScriptSig` to order
 * signatures correctly -- OP_CHECKMULTISIG requires signatures in the SAME
 * relative order as their pubkeys appear in the script, even when signing a
 * strict subset (m < n).
 */
function extractPubkeysFromMultisigRedeemScript(redeemScript: Uint8Array): Uint8Array[] {
  if (redeemScript.length < 3) {
    throw new Error("Redeem script too short to be a multisig script");
  }
  const mOpcode = redeemScript[0];
  if (mOpcode < Opcodes.OP_1 || mOpcode > Opcodes.OP_16) {
    throw new Error("Redeem script does not start with a valid OP_m");
  }

  const pubkeys: Uint8Array[] = [];
  let offset = 1;
  while (offset < redeemScript.length) {
    const next = redeemScript[offset];
    if (next >= Opcodes.OP_1 && next <= Opcodes.OP_16) {
      if (
        offset + 2 !== redeemScript.length ||
        redeemScript[offset + 1] !== Opcodes.OP_CHECKMULTISIG
      ) {
        throw new Error("Malformed multisig redeem script");
      }
      const n = next - Opcodes.OP_1 + 1;
      if (n !== pubkeys.length) {
        throw new Error(
          `Redeem script declares n=${n} but contains ${pubkeys.length} pubkey pushes`,
        );
      }
      return pubkeys;
    }

    const len = next;
    if (len === 0 || len >= Opcodes.OP_PUSHDATA1) {
      throw new Error("Malformed multisig redeem script: expected a pubkey push");
    }
    if (offset + 1 + len > redeemScript.length) {
      throw new Error("Malformed multisig redeem script: truncated pubkey push");
    }
    pubkeys.push(redeemScript.slice(offset + 1, offset + 1 + len));
    offset += 1 + len;
  }

  throw new Error("Malformed multisig redeem script: missing OP_n OP_CHECKMULTISIG tail");
}

/** One cosigner's signature for a specific input, paired with their pubkey. */
export interface PartialSignature {
  pubkey: Uint8Array;
  /** Output of `signMultisigInput`: a bare DER signature + SIGHASH byte. */
  signature: Uint8Array;
}

/**
 * Assemble the final P2SH multisig scriptSig from `m` (or more) partial
 * signatures: `OP_0 <sig>...<sig> <redeemScript>`. Signatures are reordered
 * to match their pubkeys' order in the redeem script -- callers do not need
 * to track cosigning order themselves.
 *
 * The leading OP_0 is MANDATORY: it is a dummy stack element that works
 * around a bug in Bitcoin's original OP_CHECKMULTISIG implementation (it
 * pops one extra stack value it never uses). Omitting it makes the script
 * fail EVERY time, permanently locking the funds.
 */
export function assembleMultisigScriptSig(
  signatures: PartialSignature[],
  redeemScript: Uint8Array,
): Uint8Array {
  const pubkeyOrder = extractPubkeysFromMultisigRedeemScript(redeemScript).map(bytesToHex);

  const ordered = [...signatures].sort((a, b) => {
    const ai = pubkeyOrder.indexOf(bytesToHex(a.pubkey));
    const bi = pubkeyOrder.indexOf(bytesToHex(b.pubkey));
    if (ai === -1 || bi === -1) {
      throw new Error("A signature's pubkey is not part of this redeem script");
    }
    return ai - bi;
  });

  const parts: Uint8Array[] = [new Uint8Array([Opcodes.OP_0])];
  for (const { signature } of ordered) {
    parts.push(pushData(signature));
  }
  parts.push(pushData(redeemScript));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * A signing request for ONE input of an unsigned multisig transaction: what
 * a coordinator device sends to a cosigner device so it can produce its
 * `PartialSignature` without ever needing the other cosigners' keys.
 */
export interface MultisigSigningRequest {
  tx: Transaction;
  inputIndex: number;
  redeemScript: Uint8Array;
}

/** Wire-friendly (JSON-serializable) form of {@link MultisigSigningRequest}. */
export interface SerializedMultisigSigningRequest {
  txHex: string;
  inputIndex: number;
  redeemScriptHex: string;
}

/**
 * Serialize a signing request for transport between cosigner devices (e.g.
 * QR code, file export, relay server). Carries no private key material --
 * only the unsigned transaction, which input to sign, and the redeem script.
 */
export function serializeMultisigSigningRequest(
  request: MultisigSigningRequest,
): SerializedMultisigSigningRequest {
  return {
    txHex: bytesToHex(serializeTransaction(request.tx)),
    inputIndex: request.inputIndex,
    redeemScriptHex: bytesToHex(request.redeemScript),
  };
}

/** Inverse of {@link serializeMultisigSigningRequest}. */
export function deserializeMultisigSigningRequest(
  serialized: SerializedMultisigSigningRequest,
): MultisigSigningRequest {
  return {
    tx: deserializeTransaction(hexToBytes(serialized.txHex)),
    inputIndex: serialized.inputIndex,
    redeemScript: hexToBytes(serialized.redeemScriptHex),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/nate/faircoin-core && bun test test/multisig-sign.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Full suite regression check, typecheck, and commit**

Run: `cd /home/nate/faircoin-core && bun test && bun run typecheck`
Expected: all PASS, no type errors.

```bash
cd /home/nate/faircoin-core
git add src/multisig-sign.ts test/multisig-sign.test.ts
git commit -m "feat(multisig): add scriptSig assembler and signing-request exchange format"
```

*Note on scope: this is a minimal, purpose-built exchange format (unsigned tx + input index + redeem script, as hex strings) — NOT the full BIP174 PSBT binary format. That is a deliberate scope decision for Layer 1: Oxy Pay's "Shared Pockets" coordination UX is a separate later effort and can wrap this format (or replace it with real PSBT) without changing anything in Tasks 1–5.*

---

## Task 4: `scriptForAddress` + P2SH-aware `buildTransaction` (pure lib — feasibility D, pay INTO a multisig address)

**Files:**
- Modify: `/home/nate/faircoin-core/src/script.ts` (add `scriptForAddress`, add `decodeAddress` to its encoding.js import)
- Modify: `/home/nate/faircoin-core/src/transaction.ts` (use `scriptForAddress` in `buildTransaction`, remove the now-dead `parseAddressToHash160`, update imports)
- Modify: `/home/nate/faircoin-core/test/transaction.test.ts` (append)

**Interfaces:**
- Consumes: `decodeAddress` from `src/encoding.ts`; `type NetworkConfig` from `src/network.ts`; existing `createP2PKHScript`/`createP2SHScript`.
- Produces: `scriptForAddress(address: string, network: NetworkConfig): Uint8Array`. Task 5 (`buildMultisigSpend`) reuses it for both recipient outputs and change.

This task fixes a real, demonstrable bug: today, `buildTransaction` always calls `createP2PKHScript(hash)` for every recipient and the change address, regardless of what kind of address it is. Paying a P2SH (multisig) address through it today silently produces a P2PKH-shaped output locking the funds to a hash with **no matching private key** — the coins would be permanently unspendable. The test below proves the fix by asserting the exact correct P2SH bytes AND asserting the old buggy P2PKH bytes are NOT produced.

- [ ] **Step 1: Write the failing test**

Append to `/home/nate/faircoin-core/test/transaction.test.ts`. First, extend its import from `../src/script.js` (currently `import { createP2PKHScript } from "../src/script.js";`) to:

```typescript
import { createP2PKHScript, isP2SHScript, isP2PKHScript } from "../src/script.js";
```

Then append:

```typescript
describe("buildTransaction — P2SH-aware outputs (multisig-ready)", () => {
  test("paying a P2SH (multisig) recipient emits a P2SH scriptPubKey, not P2PKH", () => {
    const { utxo, senderAddr } = getFixtures();
    // Real 2-of-3 multisig mainnet address (see multisig-script.test.ts for
    // the redeem script it was derived from).
    const multisigRecipient = "7iKBxUNbBbTa8n1Q32oLucmvmKL7c572P2";

    const tx = buildTransaction({
      utxos: [utxo],
      recipients: [{ address: multisigRecipient, value: 500_000_000n }],
      changeAddress: senderAddr,
      feePerByte: 10n,
      network: MAINNET,
    });

    const recipientOutput = tx.outputs[0];
    expect(isP2SHScript(recipientOutput.scriptPubKey)).toBe(true);
    expect(bytesToHex(recipientOutput.scriptPubKey)).toBe(
      "a914ae79902ae33900b679c76ced8576362e4abb15e887",
    );
    // The pre-fix behaviour would have produced this P2PKH-shaped script,
    // which pays a hash with NO matching private key -- funds sent that way
    // would be permanently unspendable. Guard against regressing to it.
    expect(bytesToHex(recipientOutput.scriptPubKey)).not.toBe(
      "76a914ae79902ae33900b679c76ced8576362e4abb15e888ac",
    );
  });

  test("change still goes to a P2PKH scriptPubKey for a normal single-key change address", () => {
    const { utxo, senderAddr } = getFixtures();
    const tx = buildTransaction({
      utxos: [utxo],
      recipients: [{ address: senderAddr, value: 100_000_000n }],
      changeAddress: senderAddr,
      feePerByte: 10n,
      network: MAINNET,
    });
    const changeOutput = tx.outputs[tx.outputs.length - 1];
    expect(isP2PKHScript(changeOutput.scriptPubKey)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/nate/faircoin-core && bun test test/transaction.test.ts`
Expected: FAIL on the first new test — the recipient output is currently the buggy P2PKH-shaped script (`76a914ae79902ae33900b679c76ced8576362e4abb15e888ac`), not the correct P2SH one.

- [ ] **Step 3: Add `scriptForAddress` to script.ts**

In `/home/nate/faircoin-core/src/script.ts:5`, change the encoding.js import from:

```typescript
import { encodeAddress } from "./encoding.js";
```

to:

```typescript
import { decodeAddress, encodeAddress } from "./encoding.js";
```

Then insert, immediately after `createP2PKHScriptSig` (before the `// Script analysis` comment block at what is currently line 164):

```typescript
/**
 * Build the correct scriptPubKey for an address: P2SH if the address's
 * version byte matches the network's script-hash version, P2PKH if it
 * matches the pubkey-hash version. Used by transaction builders so a
 * multisig (P2SH) address is paid correctly instead of being mistaken for
 * a single-key destination.
 */
export function scriptForAddress(address: string, network: NetworkConfig): Uint8Array {
  const decoded = decodeAddress(address);
  if (decoded.version === network.scriptHash) {
    return createP2SHScript(decoded.hash);
  }
  if (decoded.version === network.pubKeyHash) {
    return createP2PKHScript(decoded.hash);
  }
  throw new Error(
    `Address ${address} does not match network ${network.name} (version byte ${decoded.version})`,
  );
}
```

- [ ] **Step 4: Use `scriptForAddress` in `buildTransaction` and remove the dead helper**

In `/home/nate/faircoin-core/src/transaction.ts:17`, change:

```typescript
import { createP2PKHScript, createP2PKHScriptSig } from "./script.js";
```

to:

```typescript
import { createP2PKHScriptSig, scriptForAddress } from "./script.js";
```

At `/home/nate/faircoin-core/src/transaction.ts:14`, remove `decodeAddress` from the encoding.js import (it becomes unused once `parseAddressToHash160` is deleted below):

```typescript
import {
  BufferWriter,
  BufferReader,
  bytesToHex,
  hexToBytes,
} from "./encoding.js";
```

Replace the output-building block (originally lines 351–370):

```typescript
  // Build outputs for recipients
  const outputs: TxOutput[] = recipients.map((recipient) => {
    const { hash } = parseAddressToHash160(recipient.address);
    return {
      value: recipient.value,
      scriptPubKey: createP2PKHScript(hash),
    };
  });

  // Determine if we need a change output
  const changeAmount = totalIn - totalOut - feeWithChange;
  const dustThreshold = network.minRelayFee;

  if (changeAmount > dustThreshold) {
    const { hash: changeHash } = parseAddressToHash160(changeAddress);
    outputs.push({
      value: changeAmount,
      scriptPubKey: createP2PKHScript(changeHash),
    });
  }
```

with:

```typescript
  // Build outputs for recipients
  const outputs: TxOutput[] = recipients.map((recipient) => ({
    value: recipient.value,
    scriptPubKey: scriptForAddress(recipient.address, network),
  }));

  // Determine if we need a change output
  const changeAmount = totalIn - totalOut - feeWithChange;
  const dustThreshold = network.minRelayFee;

  if (changeAmount > dustThreshold) {
    outputs.push({
      value: changeAmount,
      scriptPubKey: scriptForAddress(changeAddress, network),
    });
  }
```

Finally, delete the now-dead `parseAddressToHash160` function entirely (originally lines 388–397):

```typescript
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseAddressToHash160(
  address: string,
): { version: number; hash: Uint8Array } {
  const decoded = decodeAddress(address);
  return { version: decoded.version, hash: decoded.hash };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /home/nate/faircoin-core && bun test test/transaction.test.ts`
Expected: PASS, including both new tests.

- [ ] **Step 6: Full suite regression check, typecheck, and commit**

Run: `cd /home/nate/faircoin-core && bun test && bun run typecheck`
Expected: all PASS, no type errors, no unused-import warnings.

```bash
cd /home/nate/faircoin-core
git add src/script.ts src/transaction.ts test/transaction.test.ts
git commit -m "fix(transaction): buildTransaction pays P2SH addresses correctly (was fund-losing)"
```

---

## Task 5: multisig-aware fee estimation + `buildMultisigSpend` (pure lib — feasibility D, spend FROM a multisig UTXO)

**Files:**
- Create: `/home/nate/faircoin-core/src/multisig-transaction.ts`
- Create: `/home/nate/faircoin-core/test/multisig-transaction.test.ts`

**Interfaces:**
- Consumes: `scriptForAddress` from `src/script.ts` (Task 4); `type Transaction`, `type TxInput`, `type TxOutput`, `type UTXO` from `src/transaction.ts`; `type NetworkConfig` from `src/network.ts`; `SMALLEST_UNIT_NAME` from `src/branding.ts`; `createMultisigRedeemScript`/`multisigAddress` from Task 1 (test only).
- Produces: `estimateMultisigInputSize(m, redeemScriptLength): number`, `estimateMultisigTxSize(numInputs, numOutputs, m, redeemScriptLength): number`, `interface BuildMultisigSpendParams`, `buildMultisigSpend(params): Transaction`. Task 9 (FAIRWallet) calls `buildMultisigSpend`.

Scope note: `buildTransaction`'s existing input construction is already script-agnostic (an input is just `{txid, vout, scriptSig: empty, sequence}` regardless of what it spends) — the two things that actually differ for a multisig spend are the OUTPUT script (fixed generically by Task 4's `scriptForAddress`, reused here) and the FEE ESTIMATE, which today hardcodes a 148-byte P2PKH input size that is far too small for a multisig scriptSig (a 2-of-3 spend assembled in Task 3 is 253 bytes). `buildMultisigSpend` is a sibling to `buildTransaction` for the case where every input shares the SAME redeem script (a single multisig wallet/Pocket) — spending a mix of P2PKH and different-redeem-script P2SH inputs in one transaction is out of scope for Layer 1.

- [ ] **Step 1: Write the failing test**

Create `/home/nate/faircoin-core/test/multisig-transaction.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";

import { hexToBytes, bytesToHex, encodeAddress } from "../src/encoding.js";
import { hash160 } from "../src/address.js";
import { createP2SHScript } from "../src/script.js";
import { MAINNET } from "../src/network.js";
import { createMultisigRedeemScript, multisigAddress } from "../src/multisig-script.js";
import {
  estimateMultisigInputSize,
  estimateMultisigTxSize,
  buildMultisigSpend,
  type BuildMultisigSpendParams,
} from "../src/multisig-transaction.js";

const PUB1 = hexToBytes("031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f");
const PUB2 = hexToBytes("024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766");
const PUB3 = hexToBytes("02531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337");
const REDEEM_SCRIPT = createMultisigRedeemScript(2, [PUB1, PUB2, PUB3]);
const MULTISIG_ADDRESS = multisigAddress(REDEEM_SCRIPT, MAINNET);
const PUB2_ADDRESS = encodeAddress(hash160(PUB2), MAINNET.pubKeyHash);

describe("estimateMultisigInputSize / estimateMultisigTxSize", () => {
  test("matches the real assembled scriptSig size for a 2-of-3 spend (conservative upper bound)", () => {
    // multisig-sign.test.ts's real 2-of-3 scriptSig is 253 bytes (36 outpoint
    // + 3 varint + 253 scriptSig + 4 sequence = 296-byte input); the estimate
    // sizes against the 72-byte DER max (not the actual 71/72-byte real
    // signatures), so it must be >= the real input size.
    expect(estimateMultisigInputSize(2, REDEEM_SCRIPT.length)).toBe(299);
    expect(estimateMultisigInputSize(2, REDEEM_SCRIPT.length)).toBeGreaterThanOrEqual(
      36 + 3 + 253 + 4,
    );
  });

  test("full tx size estimate for 1 input, 2 outputs", () => {
    expect(estimateMultisigTxSize(1, 2, 2, REDEEM_SCRIPT.length)).toBe(377);
  });

  test("rejects a non-positive threshold", () => {
    expect(() => estimateMultisigInputSize(0, REDEEM_SCRIPT.length)).toThrow();
  });
});

describe("buildMultisigSpend", () => {
  const baseParams: BuildMultisigSpendParams = {
    utxos: [
      {
        txid: "bb".repeat(32),
        vout: 0,
        value: 10_000_000n,
        scriptPubKey: createP2SHScript(hash160(REDEEM_SCRIPT)),
      },
    ],
    redeemScript: REDEEM_SCRIPT,
    m: 2,
    recipients: [{ address: PUB2_ADDRESS, value: 4_000_000n }],
    changeAddress: MULTISIG_ADDRESS,
    feePerByte: 10n,
    network: MAINNET,
  };

  test("produces the exact real unsigned transaction bytes", () => {
    const tx = buildMultisigSpend(baseParams);
    expect(tx.outputs[0].value).toBe(4_000_000n);
    expect(bytesToHex(tx.outputs[0].scriptPubKey)).toBe(
      "76a914ebc0ee0b2ab9e8277a600c251475e22a3241a1c188ac",
    );
    expect(tx.outputs[1].value).toBe(5_996_230n);
    expect(bytesToHex(tx.outputs[1].scriptPubKey)).toBe(
      "a914ae79902ae33900b679c76ced8576362e4abb15e887",
    );
    expect(tx.inputs[0].scriptSig.length).toBe(0);
  });

  test("throws when funds are insufficient", () => {
    expect(() =>
      buildMultisigSpend({
        ...baseParams,
        recipients: [{ address: PUB2_ADDRESS, value: 50_000_000n }],
      }),
    ).toThrow(/Insufficient funds/);
  });

  test("rejects an empty UTXO list", () => {
    expect(() => buildMultisigSpend({ ...baseParams, utxos: [] })).toThrow("No UTXOs provided");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/nate/faircoin-core && bun test test/multisig-transaction.test.ts`
Expected: FAIL — `Cannot find module '../src/multisig-transaction.js'`.

- [ ] **Step 3: Write the implementation**

Create `/home/nate/faircoin-core/src/multisig-transaction.ts`:

```typescript
/**
 * Transaction building for spending FROM a P2SH multisig UTXO. All UTXOs
 * passed to `buildMultisigSpend` must share the SAME redeem script (a
 * single multisig wallet/Pocket). Spending a mix of P2PKH and P2SH-multisig
 * inputs in one transaction, or inputs with DIFFERENT redeem scripts, is
 * out of scope for Layer 1.
 */
import type { NetworkConfig } from "./network.js";
import { scriptForAddress } from "./script.js";
import { SMALLEST_UNIT_NAME } from "./branding.js";
import type { Transaction, TxInput, TxOutput, UTXO } from "./transaction.js";

const TX_OVERHEAD = 10; // version(4) + vin count(~1) + vout count(~1) + locktime(4)
const P2PKH_OUTPUT_SIZE = 34; // value(8) + scriptLen(1) + scriptPubKey(25)
const DEFAULT_SEQUENCE = 0xffffffff;

/**
 * Max DER-encoded ECDSA signature length (72 bytes) plus the 1-byte SIGHASH
 * suffix, per Bitcoin Core's own conservative fee-estimation convention.
 * Real signatures are usually 1-2 bytes shorter, so sizing against this
 * bound never underpays a multisig spend's fee.
 */
const MAX_DER_SIG_WITH_HASHTYPE = 73;

/**
 * Size of a script push for `dataLength` bytes: a 1-byte length prefix for
 * data under 76 bytes, an OP_PUSHDATA1 + 1-byte length for up to 255 bytes
 * (the practical ceiling for a standard, relay-eligible multisig redeem
 * script).
 */
function pushSize(dataLength: number): number {
  if (dataLength < 0x4c) return 1 + dataLength;
  if (dataLength <= 0xff) return 2 + dataLength;
  return 3 + dataLength;
}

/** Size of the varint prefix a transaction's scriptSig-length field takes. */
function varIntSize(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  return 5;
}

/**
 * Estimate the byte size of ONE P2SH multisig input: outpoint(36) +
 * scriptSig-length varint + scriptSig + sequence(4). The scriptSig is
 * `OP_0 <sig>...<sig> <redeemScript>` (see `assembleMultisigScriptSig`).
 */
export function estimateMultisigInputSize(m: number, redeemScriptLength: number): number {
  if (!Number.isInteger(m) || m < 1) {
    throw new Error(`Invalid multisig threshold m=${m}: must be a positive integer`);
  }
  const sigPushSize = pushSize(MAX_DER_SIG_WITH_HASHTYPE);
  const redeemPushSize = pushSize(redeemScriptLength);
  const scriptSigSize = 1 /* OP_0 dummy element */ + m * sigPushSize + redeemPushSize;
  return 36 + varIntSize(scriptSigSize) + scriptSigSize + 4;
}

/**
 * Estimate the byte size of a transaction whose inputs are ALL P2SH
 * multisig inputs sharing the same (m, redeem script length).
 */
export function estimateMultisigTxSize(
  numInputs: number,
  numOutputs: number,
  m: number,
  redeemScriptLength: number,
): number {
  return (
    TX_OVERHEAD +
    numInputs * estimateMultisigInputSize(m, redeemScriptLength) +
    numOutputs * P2PKH_OUTPUT_SIZE
  );
}

export interface BuildMultisigSpendParams {
  /** UTXOs to spend, all locked by the SAME redeem script. */
  utxos: UTXO[];
  /** The shared redeem script that locks every UTXO above. */
  redeemScript: Uint8Array;
  /** Required signature count (for fee estimation only; not enforced here). */
  m: number;
  recipients: Array<{ address: string; value: bigint }>;
  /** Where any change goes -- typically the same multisig address. */
  changeAddress: string;
  feePerByte: bigint;
  network: NetworkConfig;
}

/**
 * Build an unsigned transaction spending one or more P2SH multisig UTXOs.
 * Mirrors `buildTransaction`'s coin-accounting shape (spend everything
 * given, compute a change output if it clears the dust threshold) but sizes
 * the fee for multisig scriptSigs and pays recipients/change through
 * `scriptForAddress` so a P2SH destination (e.g. change back to the same
 * multisig address) is encoded correctly.
 *
 * Returns an UNSIGNED transaction: each input's `scriptSig` must still be
 * produced via `signMultisigInput` (per cosigner) + `assembleMultisigScriptSig`.
 */
export function buildMultisigSpend(params: BuildMultisigSpendParams): Transaction {
  const { utxos, redeemScript, m, recipients, changeAddress, feePerByte, network } = params;

  if (utxos.length === 0) {
    throw new Error("No UTXOs provided");
  }
  if (recipients.length === 0) {
    throw new Error("No recipients provided");
  }

  let totalIn = 0n;
  for (const utxo of utxos) {
    totalIn += utxo.value;
  }

  let totalOut = 0n;
  for (const recipient of recipients) {
    if (recipient.value <= 0n) {
      throw new Error("Recipient value must be positive");
    }
    totalOut += recipient.value;
  }

  const sizeWithChange = estimateMultisigTxSize(
    utxos.length,
    recipients.length + 1,
    m,
    redeemScript.length,
  );
  const feeWithChange = feePerByte * BigInt(sizeWithChange);

  const sizeWithoutChange = estimateMultisigTxSize(
    utxos.length,
    recipients.length,
    m,
    redeemScript.length,
  );
  const feeWithoutChange = feePerByte * BigInt(sizeWithoutChange);

  if (totalIn < totalOut + feeWithoutChange) {
    throw new Error(
      `Insufficient funds: have ${totalIn} ${SMALLEST_UNIT_NAME}, need ${totalOut + feeWithoutChange} (${totalOut} + ${feeWithoutChange} fee)`,
    );
  }

  const outputs: TxOutput[] = recipients.map((recipient) => ({
    value: recipient.value,
    scriptPubKey: scriptForAddress(recipient.address, network),
  }));

  const changeAmount = totalIn - totalOut - feeWithChange;
  if (changeAmount > network.minRelayFee) {
    outputs.push({
      value: changeAmount,
      scriptPubKey: scriptForAddress(changeAddress, network),
    });
  }

  const inputs: TxInput[] = utxos.map((utxo) => ({
    txid: utxo.txid,
    vout: utxo.vout,
    scriptSig: new Uint8Array(0),
    sequence: DEFAULT_SEQUENCE,
  }));

  return {
    version: 1,
    inputs,
    outputs,
    lockTime: 0,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/nate/faircoin-core && bun test test/multisig-transaction.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Full suite regression check, typecheck, and commit**

Run: `cd /home/nate/faircoin-core && bun test && bun run typecheck`
Expected: all PASS, no type errors.

```bash
cd /home/nate/faircoin-core
git add src/multisig-transaction.ts test/multisig-transaction.test.ts
git commit -m "feat(multisig): add multisig-aware fee estimation and buildMultisigSpend"
```

---

## Task 6: publish `@fairco.in/core` (PUBLISH GATE — must complete before Tasks 7-9)

**Files:**
- Modify: `/home/nate/faircoin-core/src/index.ts` (public export surface)
- Modify: `/home/nate/faircoin-core/package.json` (version bump, done via `bun version`)

**Interfaces:**
- Consumes: every export produced by Tasks 1–5.
- Produces: `@fairco.in/core@0.2.0` on the public npm registry. Task 7 depends on this exact version being live.

- [ ] **Step 1: Add the new public exports**

In `/home/nate/faircoin-core/src/index.ts`, add a new export block after the existing `script.js` export block (after `} from "./script.js";`):

```typescript
export {
  createMultisigRedeemScript,
  multisigAddress,
} from "./multisig-script.js";
```

Update the existing `script.js` export block to include `scriptForAddress`:

```typescript
export {
  Opcodes,
  pushData,
  createP2PKHScript,
  createP2SHScript,
  createP2PKHScriptSig,
  scriptForAddress,
  isP2PKHScript,
  isP2SHScript,
  extractAddressFromScript,
} from "./script.js";
```

Add two more new export blocks, after the existing `transaction.js` export block:

```typescript
export {
  type PartialSignature,
  type MultisigSigningRequest,
  type SerializedMultisigSigningRequest,
  computeMultisigSigHash,
  signMultisigInput,
  assembleMultisigScriptSig,
  serializeMultisigSigningRequest,
  deserializeMultisigSigningRequest,
} from "./multisig-sign.js";

export {
  type BuildMultisigSpendParams,
  estimateMultisigInputSize,
  estimateMultisigTxSize,
  buildMultisigSpend,
} from "./multisig-transaction.js";
```

(`derEncodeSignature`, exported at the module level in Task 2 for internal reuse, is deliberately NOT added to this public surface — it stays an implementation detail.)

- [ ] **Step 2: Verify everything builds and the full test suite passes**

```bash
cd /home/nate/faircoin-core
bun test
bun run typecheck
bun run build
```

Expected: all tests PASS, no type errors, `dist/` builds cleanly and `dist/index.d.ts` includes the new exports (spot check: `grep -c "createMultisigRedeemScript\|buildMultisigSpend\|signMultisigInput" dist/index.d.ts` should print a number > 0).

- [ ] **Step 3: Commit and push to main FIRST**

Per this repo's publish rule: the version bump + content must be committed and pushed to `main` BEFORE `bun publish` — an out-of-band publish from uncommitted work collides with the committed release (mismatched `gitHead`) and permanently burns the version number.

```bash
cd /home/nate/faircoin-core
git add src/index.ts
git commit -m "feat(multisig): export Layer 1 multisig public API"
git push origin main
```

- [ ] **Step 4: Bump the version (minor — additive API surface) and publish**

```bash
cd /home/nate/faircoin-core
bun version minor   # 0.1.1 -> 0.2.0
git push origin main --follow-tags
npm pack --dry-run  # inspect the tarball file list before publishing
bun publish --access public
```

- [ ] **Step 5: Verify propagation with a clean external install**

```bash
sleep 30
bun info @fairco.in/core version
```

Expected: prints `0.2.0`. If it's stale, retry up to 3 times with 15s gaps.

```bash
mkdir -p /tmp/verify-faircoin-core-0.2.0
cd /tmp/verify-faircoin-core-0.2.0
bun init -y
bun add @fairco.in/core@0.2.0
bun -e 'import("@fairco.in/core").then(m => console.log(
  typeof m.createMultisigRedeemScript,
  typeof m.multisigAddress,
  typeof m.signMultisigInput,
  typeof m.assembleMultisigScriptSig,
  typeof m.buildMultisigSpend,
))'
```

Expected: prints `function function function function function`. Report which version propagated and how many retries it took.

---

## Task 7: FAIRWallet — bump `@fairco.in/core` dependency (FAIRWallet-app, gated on Task 6)

**Files:**
- Modify: `/home/nate/FairCoinWorkspace/FAIRWallet/package.json:25`

**Interfaces:**
- Consumes: `@fairco.in/core@0.2.0` published in Task 6.
- Produces: nothing new — this task only unblocks Tasks 8–9 by making the new exports importable.

- [ ] **Step 1: Bump the dependency**

In `/home/nate/FairCoinWorkspace/FAIRWallet/package.json:25`, change:

```json
    "@fairco.in/core": "0.1.1",
```

to:

```json
    "@fairco.in/core": "0.2.0",
```

- [ ] **Step 2: Install and regenerate the lockfile**

```bash
cd /home/nate/FairCoinWorkspace/FAIRWallet
bun install
```

Expected: `bun.lock` updates to reference `@fairco.in/core@0.2.0`.

- [ ] **Step 3: Typecheck**

```bash
cd /home/nate/FairCoinWorkspace/FAIRWallet
bunx tsc --noEmit
```

Expected: no type errors (Tasks 1–5 were purely additive, so nothing existing should break).

- [ ] **Step 4: Commit**

Per this repo's package-manager rule, the `package.json` bump and the regenerated `bun.lock` are committed TOGETHER.

```bash
cd /home/nate/FairCoinWorkspace/FAIRWallet
git add package.json bun.lock
git commit -m "chore(deps): bump @fairco.in/core to 0.2.0 for Layer 1 multisig support"
```

---

## Task 8: FAIRWallet — register-watch multisig address (FAIRWallet-app, feasibility C)

**Files:**
- Modify: `/home/nate/FairCoinWorkspace/FAIRWallet/src/storage/database.ts` (new table + thin accessors, not directly unit-tested — see note below)
- Modify: `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/key-manager.ts` (watch-address registration — pure, unit-tested)
- Modify: `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/key-manager.test.ts`
- Create: `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/multisig.ts` (watch-registration glue)
- Modify: `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/wallet-store.ts` (two-line wiring)

**Interfaces:**
- Consumes: `multisigAddress`, `bytesToHex`, `type NetworkConfig` from `@fairco.in/core`; `Database` from `src/storage/database.ts`; `KeyManager` from `src/wallet/key-manager.ts`.
- Produces: `KeyManager.registerWatchAddress(address: string): void`, `KeyManager.getWatchAddresses(): string[]`; `Database.insertWatchAddress(address, redeemScript, label): Promise<void>`, `Database.getWatchAddresses(): Promise<WatchAddressRow[]>`; `registerMultisigWatchAddress(database, keyManager, redeemScript, network, label?): Promise<string>`, `loadWatchAddressesIntoKeyManager(database, keyManager): Promise<void>`. Task 9 extends `multisig.ts` in the same file.

A multisig address is NOT derived from this wallet's BIP44 tree, so `KeyManager.ownsAddress` (keyed off `externalKeys`/`changeKeys`, both populated only by `deriveExternal`/`deriveChange`) would never recognize it, and it would never enter the Bloom filter fed by `getAllAddresses()` — the wallet would be blind to funds sent to a multisig address it is a cosigner for. This task adds an explicit, non-HD "watch address" registration path.

Note on test coverage: `Database` wraps `expo-sqlite`, a native module this repo does not exercise under plain `bun test` (confirmed: no existing `*.test.ts` in `src/storage/` imports `database.ts`, and none of its other accessors like `insertAddress`/`markAddressUsed` have dedicated tests either). This task follows that established convention: the two new `Database` methods are thin, untested SQL wrappers; ALL new logic (ownership, watch-set membership, Bloom-filter inclusion, wipe-on-lock isolation) lives in `KeyManager`, which has no I/O and IS unit-tested below.

- [ ] **Step 1: Write the failing KeyManager tests**

Append to `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/key-manager.test.ts` (uses the same `MAINNET`/`MNEMONIC` fixtures already at the top of the file):

```typescript
describe("KeyManager watch addresses", () => {
  // Real 2-of-3 mainnet multisig P2SH address (same fixture used across the
  // @fairco.in/core multisig test suite).
  const MULTISIG_ADDRESS = "7iKBxUNbBbTa8n1Q32oLucmvmKL7c572P2";

  test("a fresh manager does not own an unregistered watch address", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    expect(km.ownsAddress(MULTISIG_ADDRESS)).toBe(false);
    expect(km.getAllAddresses()).not.toContain(MULTISIG_ADDRESS);
  });

  test("registerWatchAddress makes ownsAddress true and includes it in getAllAddresses", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    km.registerWatchAddress(MULTISIG_ADDRESS);
    expect(km.ownsAddress(MULTISIG_ADDRESS)).toBe(true);
    expect(km.getAllAddresses()).toContain(MULTISIG_ADDRESS);
    expect(km.getWatchAddresses()).toEqual([MULTISIG_ADDRESS]);
  });

  test("wipe() clears registered watch addresses (cross-wallet isolation)", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    km.registerWatchAddress(MULTISIG_ADDRESS);
    km.wipe();
    expect(km.ownsAddress(MULTISIG_ADDRESS)).toBe(false);
    expect(km.getWatchAddresses()).toEqual([]);
  });

  test("getPrivateKeyForAddress still throws for a watch address (no key material, by design)", () => {
    const km = KeyManager.fromMnemonic(MNEMONIC, MAINNET);
    km.registerWatchAddress(MULTISIG_ADDRESS);
    expect(() => km.getPrivateKeyForAddress(MULTISIG_ADDRESS)).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/nate/FairCoinWorkspace/FAIRWallet && bun test src/wallet/key-manager.test.ts`
Expected: FAIL — `registerWatchAddress`/`getWatchAddresses` do not exist on `KeyManager`.

- [ ] **Step 3: Implement the KeyManager changes**

In `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/key-manager.ts:48-49`, add a new field right after `changeKeys`:

```typescript
  private readonly externalKeys: Map<string, DerivedKeyEntry> = new Map();
  private readonly changeKeys: Map<string, DerivedKeyEntry> = new Map();
  /**
   * Addresses this wallet is watching but that are NOT derived from its HD
   * tree -- e.g. a multisig P2SH address one of this wallet's own keys is a
   * cosigner for. No private key is derivable for one of these here; a
   * multisig spend goes through `@fairco.in/core`'s multisig primitives
   * directly, keyed by whichever leg address's private key the caller
   * already obtained via `getPrivateKeyForAddress`.
   */
  private readonly watchAddresses: Set<string> = new Set();
```

At `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/key-manager.ts:213-229`, update `wipe()` to also clear watch addresses:

```typescript
  wipe(): void {
    for (const entry of this.externalKeys.values()) {
      entry.privateKey?.fill(0);
    }
    for (const entry of this.changeKeys.values()) {
      entry.privateKey?.fill(0);
    }
    this.externalKeys.clear();
    this.changeKeys.clear();
    this.watchAddresses.clear();
    this.nextExternalIndex = 0;
    this.nextChangeIndex = 0;
    // Also zeroize the account-level extended key the children derive from, so
    // no signing-capable material survives (no-op for a watch-only manager,
    // whose account key holds no private data). `wipePrivateData` overwrites the
    // private-key bytes in place, matching the in-place wipe of the cached keys.
    this.accountKey.wipePrivateData();
  }
```

At `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/key-manager.ts:320-322`, update `ownsAddress`:

```typescript
  /**
   * Whether the given address belongs to this wallet (external, change, or
   * an explicitly registered watch address -- see {@link registerWatchAddress}).
   */
  ownsAddress(address: string): boolean {
    return (
      this.externalKeys.has(address) ||
      this.changeKeys.has(address) ||
      this.watchAddresses.has(address)
    );
  }

  /**
   * Register an explicit watch address that is NOT derived from this
   * wallet's HD tree -- e.g. a multisig P2SH address one of this wallet's
   * own keys is a cosigner for. Once registered, `ownsAddress` recognises it
   * and `getAllAddresses` includes it in the Bloom-filter watch set.
   */
  registerWatchAddress(address: string): void {
    this.watchAddresses.add(address);
  }

  /** Every explicitly registered watch address (see {@link registerWatchAddress}). */
  getWatchAddresses(): string[] {
    return Array.from(this.watchAddresses);
  }
```

At `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/key-manager.ts:377-382`, update `getAllAddresses`:

```typescript
  /**
   * Get all derived addresses (external + change) plus any registered
   * watch addresses.
   */
  getAllAddresses(): string[] {
    return [
      ...this.getExternalAddresses(),
      ...this.getChangeAddresses(),
      ...this.getWatchAddresses(),
    ];
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/nate/FairCoinWorkspace/FAIRWallet && bun test src/wallet/key-manager.test.ts`
Expected: PASS (all existing cursor-persistence tests + the 4 new watch-address tests).

- [ ] **Step 5: Add the `watch_addresses` table and Database accessors**

In `/home/nate/FairCoinWorkspace/FAIRWallet/src/storage/database.ts`, insert into `SCHEMA_SQL` right after the `addresses` table block (after line 169's closing `);`):

```sql
  CREATE TABLE IF NOT EXISTS watch_addresses (
    address TEXT PRIMARY KEY,
    redeem_script TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
```

Add the row type near `AddressRow` (after line 70):

```typescript
export interface WatchAddressRow {
  address: string;
  redeem_script: string;
  label: string;
  created_at: number;
}
```

Add accessors right after `markAddressUsed` (after line 799):

```typescript
  // -----------------------------------------------------------------------
  // Watch addresses (non-HD, e.g. multisig)
  // -----------------------------------------------------------------------

  async insertWatchAddress(
    address: string,
    redeemScript: string,
    label: string,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.runAsync(
      `INSERT OR IGNORE INTO watch_addresses (address, redeem_script, label, created_at)
       VALUES (?, ?, ?, ?)`,
      address,
      redeemScript,
      label,
      now,
    );
  }

  async getWatchAddresses(): Promise<WatchAddressRow[]> {
    return this.db.getAllAsync<WatchAddressRow>(
      "SELECT * FROM watch_addresses ORDER BY created_at",
    );
  }
```

- [ ] **Step 6: Create the watch-registration glue**

Create `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/multisig.ts`:

```typescript
/**
 * FAIRWallet's minimal multisig-wallet path, consuming `@fairco.in/core`'s
 * Layer 1 multisig primitives. Watch-address registration (this file, added
 * first) lets the wallet notice funds sent to a multisig address it is a
 * cosigner for; spend building/signing/combining is added alongside it in a
 * later change to this file.
 */
import { multisigAddress, bytesToHex, type NetworkConfig } from "@fairco.in/core";
import type { Database } from "../storage/database";
import type { KeyManager } from "./key-manager";

/**
 * Compute the P2SH address for a redeem script, persist it as a watch
 * address, and register it with the KeyManager so it is owned (and
 * therefore Bloom-filter-watched) immediately -- without waiting for a
 * wallet restart.
 */
export async function registerMultisigWatchAddress(
  database: Database,
  keyManager: KeyManager,
  redeemScript: Uint8Array,
  network: NetworkConfig,
  label = "",
): Promise<string> {
  const address = multisigAddress(redeemScript, network);
  await database.insertWatchAddress(address, bytesToHex(redeemScript), label);
  keyManager.registerWatchAddress(address);
  return address;
}

/**
 * Restore every persisted watch address into the KeyManager. Called at
 * wallet init, alongside `keyManager.restoreCursors`, so multisig addresses
 * registered in a previous session are owned and watched again immediately.
 */
export async function loadWatchAddressesIntoKeyManager(
  database: Database,
  keyManager: KeyManager,
): Promise<void> {
  const rows = await database.getWatchAddresses();
  for (const row of rows) {
    keyManager.registerWatchAddress(row.address);
  }
}
```

- [ ] **Step 7: Wire the restore call into wallet-store.ts init**

In `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/wallet-store.ts`, add the import (alongside the other `./key-manager` / `./pockets` imports near the top of the file):

```typescript
import { loadWatchAddressesIntoKeyManager } from "./multisig";
```

At `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/wallet-store.ts:1102`, right after the existing `keyManager.restoreCursors(nextExternal, nextChange);` line, add:

```typescript
      // Restore any multisig watch addresses registered in a previous
      // session (Layer 1 multisig -- see src/wallet/multisig.ts) so they are
      // owned and Bloom-filter-watched again immediately, same as the HD
      // cursor restore just above.
      await loadWatchAddressesIntoKeyManager(database, keyManager);
```

This mirrors the existing `restoreCursors` wiring pattern already in this function and needs no dedicated test: `loadWatchAddressesIntoKeyManager`'s own logic is a two-line loop over already-tested `KeyManager.registerWatchAddress`, and the `Database` calls it makes are, per Step 5's note, thin untested SQL wrappers like every other accessor in this file. It is exercised the same way the rest of `initialize` is: through Task 10's manual verification pass, not a unit test.

- [ ] **Step 8: Full suite regression check, typecheck, and commit**

```bash
cd /home/nate/FairCoinWorkspace/FAIRWallet
bun test src
bunx tsc --noEmit
```

Expected: all PASS, no type errors.

```bash
cd /home/nate/FairCoinWorkspace/FAIRWallet
git add src/storage/database.ts src/wallet/key-manager.ts src/wallet/key-manager.test.ts src/wallet/multisig.ts src/wallet/wallet-store.ts
git commit -m "feat(multisig): register and restore non-HD watch addresses for multisig support"
```

---

## Task 9: FAIRWallet — minimal multisig-wallet path: build/sign/combine/finalize a spend (FAIRWallet-app)

**Files:**
- Modify: `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/multisig.ts` (append)
- Create: `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/multisig.test.ts`

**Interfaces:**
- Consumes: `buildMultisigSpend`, `type BuildMultisigSpendParams`, `signMultisigInput`, `assembleMultisigScriptSig`, `serializeMultisigSigningRequest`, `deserializeMultisigSigningRequest`, `type PartialSignature`, `type SerializedMultisigSigningRequest`, `serializeTransaction`, `hashTransaction`, `type Transaction` from `@fairco.in/core`.
- Produces: `interface MultisigSendDraft { tx, redeemScript }`, `buildMultisigSendDraft(params): MultisigSendDraft`, `exportSigningRequest(draft): SerializedMultisigSigningRequest`, `signMultisigSendRequest(serializedRequest, privateKey, pubkey): PartialSignature`, `finalizeMultisigSend(draft, signatures): { rawTx: Uint8Array; txid: string }`.

This module is deliberately decoupled from `KeyManager`/`Database`: every function takes the private key or database state it needs as an explicit argument (obtained by the CALLER, e.g. via `keyManager.getPrivateKeyForAddress(myLegAddress)`), rather than reaching into a module-level wallet singleton. That makes it fully pure and unit-testable without any native mocks, and it structurally enforces the "coordination relays only partial signatures, never private keys" constraint: `signMultisigSendRequest`'s return type is `PartialSignature` — a pubkey and a DER signature — there is no code path in this file that can return a private key.

Scope note: this minimal path handles a single-multisig-UTXO spend (`buildMultisigSendDraft` enforces exactly one input) — the common case for early usage. Multi-input coordination across several multisig UTXOs is Shared Pockets' concern, not Layer 1's.

- [ ] **Step 1: Write the failing test**

Create `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/multisig.test.ts`:

```typescript
/**
 * Tests for the minimal multisig-wallet path: build an unsigned spend from
 * a multisig UTXO, export it as a signing request, have two independent
 * "devices" (raw keypairs, simulating separate cosigner hardware) sign it
 * without ever seeing each other's private key, then combine and finalize.
 *
 * Uses the same real, reproducible fixture (fixed keys, fixed 2-of-3 redeem
 * script) as @fairco.in/core's own multisig-transaction.test.ts, so the
 * unsigned draft this test builds is byte-identical to that suite's.
 */
import { describe, test, expect } from "bun:test";
import {
  hexToBytes,
  bytesToHex,
  encodeAddress,
  hash160,
  createP2SHScript,
  MAINNET,
  createMultisigRedeemScript,
  multisigAddress,
  deserializeTransaction,
  serializeTransaction,
  type BuildMultisigSpendParams,
} from "@fairco.in/core";
import {
  buildMultisigSendDraft,
  exportSigningRequest,
  signMultisigSendRequest,
  finalizeMultisigSend,
} from "./multisig";

const PRIV1 = hexToBytes("01".repeat(32));
const PRIV3 = hexToBytes("03".repeat(32));
const PUB1 = hexToBytes("031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f");
const PUB2 = hexToBytes("024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d0766");
const PUB3 = hexToBytes("02531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe337");
const REDEEM_SCRIPT = createMultisigRedeemScript(2, [PUB1, PUB2, PUB3]);
const MULTISIG_ADDRESS = multisigAddress(REDEEM_SCRIPT, MAINNET);
const PUB2_ADDRESS = encodeAddress(hash160(PUB2), MAINNET.pubKeyHash);

function baseParams(): BuildMultisigSpendParams {
  return {
    utxos: [
      {
        txid: "bb".repeat(32),
        vout: 0,
        value: 10_000_000n,
        scriptPubKey: createP2SHScript(hash160(REDEEM_SCRIPT)),
      },
    ],
    redeemScript: REDEEM_SCRIPT,
    m: 2,
    recipients: [{ address: PUB2_ADDRESS, value: 4_000_000n }],
    changeAddress: MULTISIG_ADDRESS,
    feePerByte: 10n,
    network: MAINNET,
  };
}

describe("buildMultisigSendDraft", () => {
  test("produces the exact real unsigned draft", () => {
    const draft = buildMultisigSendDraft(baseParams());
    expect(draft.tx.outputs[0].value).toBe(4_000_000n);
    expect(draft.tx.outputs[1].value).toBe(5_996_230n);
    expect(bytesToHex(draft.redeemScript)).toBe(bytesToHex(REDEEM_SCRIPT));
  });

  test("rejects a draft spanning more than one multisig UTXO", () => {
    const params = baseParams();
    params.utxos = [...params.utxos, { ...params.utxos[0], vout: 1 }];
    expect(() => buildMultisigSendDraft(params)).toThrow(/exactly one/);
  });
});

describe("exportSigningRequest / signMultisigSendRequest / finalizeMultisigSend", () => {
  test("two independent cosigner devices produce the exact real finalized transaction", () => {
    const draft = buildMultisigSendDraft(baseParams());
    const request = exportSigningRequest(draft);

    // Device 1: only ever sees PRIV1. Device 3: only ever sees PRIV3.
    // Neither device's function call has access to the other's key.
    const partial1 = signMultisigSendRequest(request, PRIV1, PUB1);
    const partial3 = signMultisigSendRequest(request, PRIV3, PUB3);

    expect(partial1.pubkey).toBe(PUB1);
    expect(bytesToHex(partial1.signature)).toBe(
      "30450221009fb3526a098539a06a31cdf549f22b851025b8fca09d377b85592c0af1a3603a022063a1a91a073e65a4290ddb042122d42c959088424ae64aa344db8dac85272dc201",
    );
    expect(bytesToHex(partial3.signature)).toBe(
      "3044022036cf948a33d4bb0decc58a4df0617a1e23666df7b0a8ee6ae9c820b138f16dcf0220050f3cf171c492acae16432a83be20760a8a5e37df2c9b4993b5f102d9255b8701",
    );

    const { rawTx, txid } = finalizeMultisigSend(draft, [partial1, partial3]);
    expect(bytesToHex(rawTx)).toBe(
      "0100000001bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb00000000fdfd00004830450221009fb3526a098539a06a31cdf549f22b851025b8fca09d377b85592c0af1a3603a022063a1a91a073e65a4290ddb042122d42c959088424ae64aa344db8dac85272dc201473044022036cf948a33d4bb0decc58a4df0617a1e23666df7b0a8ee6ae9c820b138f16dcf0220050f3cf171c492acae16432a83be20760a8a5e37df2c9b4993b5f102d9255b87014c695221031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f21024d4b6cd1361032ca9bd2aeb9d900aa4d45d9ead80ac9423374c451a7254d07662102531fe6068134503d2723133227c867ac8fa6c83c537e9a44c3c5bdbdcb1fe33753aeffffffff0200093d00000000001976a914ebc0ee0b2ab9e8277a600c251475e22a3241a1c188acc67e5b000000000017a914ae79902ae33900b679c76ced8576362e4abb15e88700000000",
    );
    expect(txid).toBe("aac86bdcb7ec8ed28a9322e2c078a9d730d52613576ae3f7f7db623788c4a241");

    // The finalized transaction round-trips through the wire format.
    const parsed = deserializeTransaction(rawTx);
    expect(bytesToHex(serializeTransaction(parsed))).toBe(bytesToHex(rawTx));
  });

  test("the serialized signing request carries no private key material", () => {
    const draft = buildMultisigSendDraft(baseParams());
    const request = exportSigningRequest(draft);
    const requestJson = JSON.stringify(request);
    expect(requestJson).not.toContain(bytesToHex(PRIV1));
    expect(requestJson).not.toContain(bytesToHex(PRIV3));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /home/nate/FairCoinWorkspace/FAIRWallet && bun test src/wallet/multisig.test.ts`
Expected: FAIL — `buildMultisigSendDraft`/`exportSigningRequest`/`signMultisigSendRequest`/`finalizeMultisigSend` are not exported yet.

- [ ] **Step 3: Append the implementation**

Update the import block at the top of `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/multisig.ts` to:

```typescript
import {
  multisigAddress,
  bytesToHex,
  buildMultisigSpend,
  signMultisigInput,
  assembleMultisigScriptSig,
  serializeMultisigSigningRequest,
  deserializeMultisigSigningRequest,
  serializeTransaction,
  hashTransaction,
  type NetworkConfig,
  type Transaction,
  type BuildMultisigSpendParams,
  type PartialSignature,
  type SerializedMultisigSigningRequest,
} from "@fairco.in/core";
import type { Database } from "../storage/database";
import type { KeyManager } from "./key-manager";
```

Then append to the end of the file (after `loadWatchAddressesIntoKeyManager`):

```typescript
/** An unsigned single-input multisig spend, ready to be signed by cosigners. */
export interface MultisigSendDraft {
  tx: Transaction;
  redeemScript: Uint8Array;
}

/**
 * Build an unsigned multisig spend. Limited to spending exactly ONE
 * multisig UTXO -- multi-input coordination across several multisig UTXOs
 * is out of scope for this minimal path (see the module doc comment).
 */
export function buildMultisigSendDraft(params: BuildMultisigSpendParams): MultisigSendDraft {
  if (params.utxos.length !== 1) {
    throw new Error(
      "buildMultisigSendDraft supports exactly one multisig UTXO input; multi-input multisig spends are not yet supported",
    );
  }
  const tx = buildMultisigSpend(params);
  return { tx, redeemScript: params.redeemScript };
}

/**
 * Export a draft as a signing request a cosigner device can consume. Carries
 * no private key material -- only the unsigned tx, the input index, and the
 * redeem script.
 */
export function exportSigningRequest(draft: MultisigSendDraft): SerializedMultisigSigningRequest {
  return serializeMultisigSigningRequest({
    tx: draft.tx,
    inputIndex: 0,
    redeemScript: draft.redeemScript,
  });
}

/**
 * Sign a received request with THIS device's own private key. Returns only
 * a `PartialSignature` (pubkey + DER signature) -- the private key argument
 * is never read back out of this function in any form.
 */
export function signMultisigSendRequest(
  serializedRequest: SerializedMultisigSigningRequest,
  privateKey: Uint8Array,
  pubkey: Uint8Array,
): PartialSignature {
  const { tx, inputIndex, redeemScript } = deserializeMultisigSigningRequest(serializedRequest);
  const signature = signMultisigInput(tx, inputIndex, redeemScript, privateKey);
  return { pubkey, signature };
}

/**
 * Combine `m` (or more) partial signatures into the final scriptSig and
 * produce the broadcastable raw transaction + its txid.
 */
export function finalizeMultisigSend(
  draft: MultisigSendDraft,
  signatures: PartialSignature[],
): { rawTx: Uint8Array; txid: string } {
  const scriptSig = assembleMultisigScriptSig(signatures, draft.redeemScript);
  const finalTx: Transaction = {
    ...draft.tx,
    inputs: [{ ...draft.tx.inputs[0], scriptSig }],
  };
  const rawTx = serializeTransaction(finalTx);
  const txid = hashTransaction(finalTx);
  return { rawTx, txid };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /home/nate/FairCoinWorkspace/FAIRWallet && bun test src/wallet/multisig.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite regression check, typecheck, and commit**

```bash
cd /home/nate/FairCoinWorkspace/FAIRWallet
bun test src
bunx tsc --noEmit
```

Expected: all PASS, no type errors.

```bash
cd /home/nate/FairCoinWorkspace/FAIRWallet
git add src/wallet/multisig.ts src/wallet/multisig.test.ts
git commit -m "feat(multisig): add build/sign/combine/finalize path for a multisig spend"
```

---

## Task 10: security-reviewer audit (MANDATORY final gate — blocks any real-money use)

This is a review gate, not a code task. Nothing in Tasks 1–9 should be treated as safe for mainnet funds until this task completes with a sign-off.

**Review scope (the full diff from this plan):**
- `/home/nate/faircoin-core/src/multisig-script.ts`
- `/home/nate/faircoin-core/src/script.ts` (the `scriptForAddress` addition)
- `/home/nate/faircoin-core/src/transaction.ts` (the `derEncodeSignature` export + `buildTransaction` P2SH fix)
- `/home/nate/faircoin-core/src/multisig-sign.ts`
- `/home/nate/faircoin-core/src/multisig-transaction.ts`
- `/home/nate/faircoin-core/src/index.ts` (public export surface)
- `/home/nate/FairCoinWorkspace/FAIRWallet/src/storage/database.ts` (the `watch_addresses` table)
- `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/key-manager.ts`
- `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/multisig.ts`
- `/home/nate/FairCoinWorkspace/FAIRWallet/src/wallet/wallet-store.ts` (the two-line wiring change)

- [ ] **Step 1: Confirm the mechanical gates are green before requesting review**

```bash
cd /home/nate/faircoin-core && bun test && bun run typecheck
cd /home/nate/FairCoinWorkspace/FAIRWallet && bun test src && bunx tsc --noEmit
```

Expected: all PASS in both repos.

- [ ] **Step 2: Spawn the `security-reviewer` agent against the diff above with this explicit checklist**

- **No key-leak path**: confirm no function in the reviewed diff returns, logs, or serializes a private key. `signMultisigInput`/`signMultisigSendRequest` in particular — trace the return value.
- **OP_0 dummy element**: confirm `assembleMultisigScriptSig` always prepends `OP_0` before the signatures — its omission is a well-known Bitcoin `OP_CHECKMULTISIG` implementation bug (an off-by-one stack pop) that would make the script fail on EVERY spend attempt, permanently locking the funds. This is not a "nice to have" — it's the single highest-consequence line in the diff.
- **Sighash correctness (BIP16)**: confirm `computeMultisigSigHash` substitutes the REDEEM SCRIPT (not the P2SH scriptPubKey) as the scriptCode for the signed input — verify against the real, independently-reproducible vectors in `multisig-sign.test.ts` (the sighash and signature hex were computed by actually running this package's own pinned `@noble/secp256k1`, not invented).
- **Low-S normalization (BIP-62)**: confirm `signMultisigInput` normalizes S the same way `signInput` does, so signatures are malleability-resistant.
- **m/n bounds**: confirm `createMultisigRedeemScript` rejects `n > 16` (hard OP_1..OP_16 opcode ceiling — a violation here would silently encode the WRONG opcode, e.g. `OP_NOP` instead of an intended `OP_17` that doesn't exist) and rejects any construction exceeding the 520-byte standard-relay redeem-script limit.
- **Malformed-input safety**: `extractPubkeysFromMultisigRedeemScript` parses attacker-influenceable-shaped byte arrays (a redeem script received from a cosigner or read off-chain) — confirm every slice is bounds-checked and no malformed input causes an out-of-bounds read or an uncaught exception mid-signing.
- **Fee-estimate conservatism**: confirm `estimateMultisigInputSize` sizes against the 72-byte DER-signature maximum (not a real signature's actual, shorter length) so a real spend's `buildMultisigSpend` fee never underpays — verified against the real 253-byte assembled scriptSig in `multisig-transaction.test.ts`.
- **No secrets at rest or in transit**: confirm the `watch_addresses` table and `SerializedMultisigSigningRequest` carry only public data (addresses, redeem scripts, pubkeys, signatures) — grep the diff for any code path that could persist or transmit a private key or mnemonic alongside multisig state.
- **Backward compatibility**: confirm every Task 1–5 change is additive and `signInput`/`buildTransaction`'s existing single-key behavior for a normal P2PKH-to-P2PKH send is unchanged (covered by the existing `transaction.test.ts` suite continuing to pass).

- [ ] **Step 3: Flag the assumption that needs a LIVE TESTNET PROBE, not just review**

This plan's test vectors prove the CRYPTO is byte-correct: the redeem script, sighash, signatures, and assembled scriptSig all match what an independent execution of the same deterministic algorithm produces. They do NOT prove that FairCoin Core's actual node/consensus software accepts a standard BIP16 P2SH + BIP11 `OP_CHECKMULTISIG` script as relay-standard or consensus-valid — some Bitcoin forks alter `IsStandard()` policy or disable less-common script types. Before ANY real-money use:

1. Fund a real testnet 2-of-3 multisig address (constructed via `multisigAddress`) from a testnet faucet or an existing testnet wallet.
2. Build and fully sign a real spend from it using this plan's `buildMultisigSendDraft`/`signMultisigSendRequest`/`finalizeMultisigSend` path (or the equivalent direct `@fairco.in/core` calls).
3. Broadcast the raw transaction via FAIRWallet's existing SPV client (`SPVClient.broadcastTransaction`, already used by `sendTransaction` in `wallet-store.ts`) and confirm it is relayed, accepted into a block, and correctly recognized as spent by the wallet's own SPV receive path.

- [ ] **Step 4: Record the outcome**

This feature is BLOCKED for any real-money use until BOTH:
(a) the `security-reviewer` agent has signed off on the checklist in Step 2 with no unresolved findings, AND
(b) the live testnet probe in Step 3 has confirmed a real multisig spend broadcasts, confirms, and is recognized by the wallet.

Report both outcomes explicitly (pass/fail, with findings) rather than treating either as implied by the other — a clean code review does not substitute for proof the FairCoin network accepts the script type, and a successful testnet broadcast does not substitute for a security review of the key-handling code path.

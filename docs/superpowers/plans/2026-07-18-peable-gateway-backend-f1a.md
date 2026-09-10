# Peable Gateway — Backend core (F1 Track A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Peable Gateway's non-custodial `PaymentIntent` core — `@peable.to/shared-types` + a from-scratch `@peable.to/backend` that creates payment intents, derives per-intent watch-only addresses from a merchant xpub, watches FairCoin for settlement, and fires signed webhooks + realtime socket events — independently testable via API + FairCoin testnet, with **no wallet app required**.

**Architecture:** Merchant (authenticated via a Console-issued Oxy service app-key) calls `POST /v1/payment_intents`; the backend derives a fresh receive address from the merchant's **watch-only xpub** (public key only — cannot spend), returns a `pi_…` intent + `client_secret`. A tip-driven settlement watcher observes that address on the FairCoin Explorer; on mempool-seen → `confirming`, on N confs → `settled`, emitting Socket.io events and an HMAC-signed webhook. The payer's self-custody wallet (Track B, separate plan) signs the actual on-chain tx — the backend never holds keys or funds.

**Tech Stack:** Bun + Express + Mongoose (MongoDB) + Socket.io; `@oxy.so/core/server` (auth/CORS/rate-limit/`safeFetch`); `@fairco.in/core` (address/units/network) + `@scure/bip32` (xpub derivation); `bun test`.

## Global Constraints

- **Non-custody invariant (legal firewall — never violate):** (1) private keys live only on user devices; the backend never sees/stores/derives them. (2) The backend never possesses or controls funds, ever. (3) The user initiates + signs every payment. (4) Of a merchant the backend stores at most a **watch-only xpub** (public → cannot spend). A change violating 1–4 is a legal bug.
- **Realtime-first:** REST for commands, **Socket.io for state**. No polling on the critical path. The `PaymentIntent` is the single source of truth.
- **Stripe parity:** prefixed IDs (`pi_`, `evt_`); `Idempotency-Key` on every create; `Peable-Version` date header; HMAC-signed webhooks with dotted event types (`payment_intent.settled`); `client_secret` reference; `peable.*` SDK ergonomics (later); test/live mode per app-key.
- **Amounts:** `bigint` base units (m⊜; `1 FAIR = UNITS_PER_COIN = 100_000_000`). Never floats. Mongo stores the decimal string; the domain uses `bigint`.
- **Package manager:** `bun` only; hoisted linker (`bunfig.toml` at root). Commit `bun.lock` with its `package.json` change. Tests via `bun test`.
- **Clean code, no tricky things:** no `as any`, `@ts-ignore`, `!`, `var`, `console.log`, silent `catch {}`, TODO/HACK, barrel/re-export shims. Direct imports from owners. `setInterval` in singletons calls `.unref?.()`.
- **Fix upstream (authorized):** if `@fairco.in/core`, the FairCoin Explorer, or `@oxy.so/core` needs a capability (e.g. a watch-only address endpoint), improve it at the source cleanly — never monkey-patch downstream.
- **Auth:** merchant routes use `oxyClient.serviceAuth()` (confidential app-key); any user routes use `requireOxyAuth`/`getRequiredOxyUserId` from `@oxy.so/core/server`. CORS via `createOxyCors`; outbound webhook fetch via `safeFetch` (SSRF).
- **Verification chain uses FairCoin testnet** (`TESTNET` from `@fairco.in/core`).

---

## File Structure

```
packages/shared-types/src/
  money.ts           # Amount helpers over bigint base units (re-uses @fairco.in/core UNITS_PER_COIN)
  paymentIntent.ts   # PaymentIntentStatus, PaymentIntent DTO, CreatePaymentIntentParams
  event.ts           # WebhookEventType, WebhookEvent<T> envelope
  index.ts           # package public API (entry, not a compat barrel)

packages/backend/src/
  config.ts                     # env parsing (typed, no magic numbers)
  db.ts                         # mongoose connection
  lib/ids.ts                    # prefixed id generator (pi_, evt_)
  lib/money.ts                  # bigint <-> Mongo-string helpers
  services/derivation.ts        # deriveIntentAddress(xpub, change, index, network) -> string
  services/intentState.ts       # pure state machine: nextStatus(current, event)
  services/webhookSigner.ts     # signWebhook(secret, rawBody, timestamp) -> signature header
  services/explorer.ts          # Explorer HTTP client: getTip(), getAddressReceived(address)
  services/webhookDispatcher.ts # deliver(event, endpoint) via safeFetch + retries
  services/settlementWatcher.ts # tip-driven: match tx to intent, advance state, emit
  models/Merchant.ts            # Oxy app id, xpub, derivationIndex, webhook url/secret, requiredConfirmations, network
  models/PaymentIntent.ts       # pi_ id, merchantId, amount(str), address, index, status, txid, confs, clientSecret, idempotencyKey, expiresAt, metadata
  realtime/socket.ts            # Socket.io init + emitIntentUpdate(intent)
  routes/paymentIntents.ts      # POST /v1/payment_intents, GET /:id, POST /:id/reject
  server.ts                     # express wiring, Peable-Version header, error handler, watcher boot
  __tests__/…                   # colocated bun tests per unit
```

---

### Task 1: Repo prep — branch, archive dead backend, scaffold new packages

**Files:**
- Create branch `feat/peable-gateway-f1a`
- Archive + remove: `packages/backend/*` (custodial, incl. uncommitted WIP)
- Reset: `packages/shared-types/src/*`
- Modify: `packages/backend/package.json`, `packages/shared-types/package.json`, root `tsconfig.json` refs

**Interfaces:**
- Produces: an empty, compiling `@peable.to/backend` + `@peable.to/shared-types` skeleton; `packages/frontend` left untouched (Track B).

- [ ] **Step 1: Preserve the current WIP so nothing is lost.** From `/home/nate/Oxy/Peable`:

```bash
git checkout -b archive/custodial-backend-2026-07-18
git add -A && git commit -m "chore: archive custodial backend + WIP before Gateway rewrite"
git checkout main && git checkout -b feat/peable-gateway-f1a
```

Expected: the archive branch holds the full pre-rewrite tree; the feature branch starts from clean `main`.

- [ ] **Step 2: Remove the custodial backend source, keep the package shell.**

```bash
git rm -r packages/backend/src packages/backend/server.ts packages/backend/dist
```

- [ ] **Step 3: Rewrite `packages/backend/package.json`** — name `@peable.to/backend`, scripts `dev` (`bun --watch src/server.ts`), `build` (`tsc`), `test` (`bun test`), `typecheck` (`tsc --noEmit`); deps: `express`, `mongoose`, `socket.io`, `@oxy.so/core`, `@fairco.in/core`, `@scure/bip32`, `zod`; devDeps `@types/express`, `mongodb-memory-server`. Run `bun install` from root; commit `bun.lock` in this task's commit.

- [ ] **Step 4: Reset `packages/shared-types/src`** — delete the custodial type files (`wallet.ts`, `paymentMethod.ts`, old `payment.ts`/`invoice.ts`/`transaction.ts`), leave `src/` empty except a placeholder `index.ts` (`export {};`).

- [ ] **Step 5: Verify the monorepo still installs + compiles.**

Run: `cd /home/nate/Oxy/Peable && bun install && bun run --filter @peable.to/shared-types typecheck && bun run --filter @peable.to/backend typecheck`
Expected: PASS (empty packages compile).

- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "chore(gateway): scaffold empty @peable.to/backend + reset shared-types"
```

---

### Task 2: shared-types — PaymentIntent contract

**Files:**
- Create: `packages/shared-types/src/money.ts`, `paymentIntent.ts`, `event.ts`
- Modify: `packages/shared-types/src/index.ts`
- Test: `packages/shared-types/src/__tests__/paymentIntent.test.ts`

**Interfaces:**
- Produces:
  - `type PaymentIntentStatus = 'created' | 'awaiting_approval' | 'approved' | 'broadcast' | 'confirming' | 'settled' | 'expired' | 'failed' | 'rejected'`
  - `interface PaymentIntent { id: string; object: 'payment_intent'; status: PaymentIntentStatus; amount: string; currency: 'FAIR'; network: NetworkType; address: string; merchantId: string; txid: string | null; confirmations: number; clientSecret: string; metadata: Record<string,string>; expiresAt: string; createdAt: string; updatedAt: string }`
  - `interface CreatePaymentIntentParams { amount: string; network: NetworkType; metadata?: Record<string,string>; expiresInSeconds?: number }`
  - `type WebhookEventType = 'payment_intent.confirming' | 'payment_intent.settled' | 'payment_intent.failed' | 'payment_intent.rejected' | 'payment_intent.expired'`
  - `interface WebhookEvent<T = PaymentIntent> { id: string; object: 'event'; type: WebhookEventType; created: string; data: { object: T } }`
  - `const isValidStatusTransition(from, to): boolean` (shared with backend state machine).

- [ ] **Step 1: Write the failing test** (`paymentIntent.test.ts`):

```ts
import { test, expect } from 'bun:test';
import { isValidStatusTransition } from '../paymentIntent';

test('allows created -> awaiting_approval', () => {
  expect(isValidStatusTransition('created', 'awaiting_approval')).toBe(true);
});
test('forbids settled -> confirming (except reorg handled separately)', () => {
  expect(isValidStatusTransition('settled', 'confirming')).toBe(false);
});
test('forbids skipping broadcast', () => {
  expect(isValidStatusTransition('awaiting_approval', 'settled')).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `bun test packages/shared-types/src/__tests__/paymentIntent.test.ts` — Expected: FAIL (`isValidStatusTransition` undefined).

- [ ] **Step 3: Implement `money.ts`** — re-export `UNITS_PER_COIN` from `@fairco.in/core` and a guard `isBaseUnitString(s: string): boolean` (non-negative integer string). No floats.

- [ ] **Step 4: Implement `paymentIntent.ts`** — the types above + a transition table:

```ts
import type { NetworkType } from '@fairco.in/core';
export type PaymentIntentStatus = 'created' | 'awaiting_approval' | 'approved' | 'broadcast' | 'confirming' | 'settled' | 'expired' | 'failed' | 'rejected';
const ALLOWED: Record<PaymentIntentStatus, readonly PaymentIntentStatus[]> = {
  created: ['awaiting_approval', 'expired'],
  awaiting_approval: ['approved', 'rejected', 'expired'],
  approved: ['broadcast', 'failed'],
  broadcast: ['confirming', 'failed'],
  confirming: ['settled', 'failed'],
  settled: [],
  expired: [], failed: [], rejected: [],
};
export function isValidStatusTransition(from: PaymentIntentStatus, to: PaymentIntentStatus): boolean {
  return ALLOWED[from].includes(to);
}
// … PaymentIntent, CreatePaymentIntentParams interfaces …
```

- [ ] **Step 5: Implement `event.ts`** + wire `index.ts` to export from `money`/`paymentIntent`/`event` (package entry, direct exports — not a compat shim).

- [ ] **Step 6: Run tests + typecheck.** Run: `bun test packages/shared-types && bun run --filter @peable.to/shared-types typecheck` — Expected: PASS.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(shared-types): PaymentIntent + webhook event contract"`

---

### Task 3: Prefixed ID generator

**Files:** Create `packages/backend/src/lib/ids.ts`; Test `packages/backend/src/lib/__tests__/ids.test.ts`

**Interfaces:** Produces `newId(prefix: 'pi' | 'evt'): string` → `` `${prefix}_${24 hex chars}` `` using `crypto.getRandomValues`; `clientSecretFor(id: string): string` → `` `${id}_secret_${32 hex}` ``.

- [ ] **Step 1: Failing test** — asserts `newId('pi')` matches `/^pi_[0-9a-f]{24}$/`, two calls differ, `clientSecretFor('pi_x')` starts with `pi_x_secret_`.
- [ ] **Step 2: Run — FAIL.** `bun test packages/backend/src/lib/__tests__/ids.test.ts`
- [ ] **Step 3: Implement** with `crypto.getRandomValues(new Uint8Array(n))` → hex. No `Math.random`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(backend): prefixed id generator"`

---

### Task 4: Watch-only derivation from merchant xpub (the trickiest pure unit)

**Files:** Create `packages/backend/src/services/derivation.ts`; Test `…/__tests__/derivation.test.ts`

**Interfaces:** Produces `deriveIntentAddress(xpub: string, change: number, index: number, network: NetworkConfig): string` — public-key-only; MUST throw if handed a private `xprv` (non-custody guard).

- [ ] **Step 1: Write the failing test** with a fixed testnet xpub vector (generate once with `@fairco.in/core` `deriveKeyFromSeed` from a known mnemonic, neuter to xpub, record expected addresses):

```ts
import { test, expect } from 'bun:test';
import { TESTNET } from '@fairco.in/core';
import { deriveIntentAddress } from '../derivation';

const XPUB = '<record from setup script>';
test('derives deterministic external addresses', () => {
  const a0 = deriveIntentAddress(XPUB, 0, 0, TESTNET);
  const a1 = deriveIntentAddress(XPUB, 0, 1, TESTNET);
  expect(a0).toBe('<expected addr 0>');
  expect(a1).not.toBe(a0);
});
test('rejects a private xprv (non-custody guard)', () => {
  expect(() => deriveIntentAddress('<an xprv>', 0, 0, TESTNET)).toThrow();
});
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** using `@scure/bip32` + `@fairco.in/core` (standard libs, no tricks):

```ts
import { HDKey } from '@scure/bip32';
import { publicKeyToAddress } from '@fairco.in/core';
import type { NetworkConfig } from '@fairco.in/core';

export function deriveIntentAddress(xpub: string, change: number, index: number, network: NetworkConfig): string {
  const node = HDKey.fromExtendedKey(xpub, { public: network.bip32.public, private: network.bip32.private });
  if (node.privateKey) throw new Error('watch-only violation: extended key carries a private key');
  const child = node.deriveChild(change).deriveChild(index);
  if (!child.publicKey) throw new Error('failed to derive public key');
  return publicKeyToAddress(child.publicKey, network);
}
```

- [ ] **Step 4: Setup vector** — write `scripts/gen-xpub-vector.ts` (a `bun run` one-off) that derives the xpub + expected addresses from a fixed mnemonic; paste values into the test. Keep the script in-repo for reproducibility.
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6: Commit.** `git commit -am "feat(backend): watch-only xpub address derivation"`

> If a cleaner home is wanted, the authorized fix-upstream move is to add `deriveWatchOnlyAddress` to `@fairco.in/core` and re-export here — a follow-up, not required for F1A (using `@scure/bip32` directly is standard, not tricky).

---

### Task 5: Intent state machine (pure) + expiry/underpayment semantics

**Files:** Create `packages/backend/src/services/intentState.ts`; Test `…/__tests__/intentState.test.ts`

**Interfaces:** Produces `applyEvent(current: PaymentIntentStatus, event: IntentEvent): PaymentIntentStatus` where `type IntentEvent = 'deliver' | 'approve' | 'reject' | 'broadcast' | 'mempool_seen' | 'confirmed' | 'underpaid' | 'expire' | 'reorg_below_threshold'`. Uses `isValidStatusTransition` from shared-types; throws on an illegal event for the current state (fail loud, no silent no-op).

- [ ] **Step 1: Failing test** — table of (state, event) → expected next; illegal combos throw; `reorg_below_threshold` on `settled` → `confirming`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** an explicit `switch` mapping each event to a target status, validating via `isValidStatusTransition` (except the documented `reorg_below_threshold` exception, asserted with a comment).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(backend): payment-intent state machine"`

---

### Task 6: Webhook HMAC signer

**Files:** Create `packages/backend/src/services/webhookSigner.ts`; Test `…/__tests__/webhookSigner.test.ts`

**Interfaces:** Produces `signWebhook(secret: string, rawBody: string, timestamp: number): string` → Stripe-style `` `t=${timestamp},v1=${hexHmacSha256}` ``; `verifyWebhook(secret, rawBody, header, toleranceSec): boolean` (constant-time compare).

- [ ] **Step 1: Failing test** — a known secret+body+timestamp yields a stable signature; `verifyWebhook` accepts it and rejects a tampered body / stale timestamp.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** with `crypto.subtle` / Bun `createHmac`; constant-time compare via `crypto.timingSafeEqual` (no `!==` on secrets — mirrors `verifySecret` convention).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(backend): webhook HMAC signer/verifier"`

---

### Task 7: Mongoose models — Merchant + PaymentIntent (watch-only enforced)

**Files:** Create `packages/backend/src/models/Merchant.ts`, `models/PaymentIntent.ts`, `lib/money.ts`; Test `…/__tests__/models.test.ts` (uses `mongodb-memory-server`)

**Interfaces:**
- `Merchant`: `{ oxyAppId: string (unique); network: NetworkType; xpub: string; nextDerivationIndex: number; webhookUrl: string; webhookSecret: string; requiredConfirmations: number; livemode: boolean }`
- `PaymentIntent` doc mirrors the DTO; `amount` stored as string; `bigint` helpers in `lib/money.ts` (`toBaseUnits(str): bigint`, `fromBaseUnits(b): string`).
- Produces `reserveNextAddress(merchant): { index, address }` (atomic `$inc` on `nextDerivationIndex` via `findOneAndUpdate`, then `deriveIntentAddress`).

- [ ] **Step 1: Failing test** — save a Merchant with an `xpub`; a pre-save hook **rejects** an `xprv` (non-custody guard) and rejects any field literally named `privateKey`/`mnemonic`/`seed`; `reserveNextAddress` returns monotonically increasing indexes + distinct addresses under concurrent calls.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** schemas; Merchant pre-validate hook calling `deriveIntentAddress(xpub,0,0,network)` in a try — if it throws (or the key is private), reject. `reserveNextAddress` uses `Merchant.findOneAndUpdate({_id}, {$inc:{nextDerivationIndex:1}}, {new:false})` to claim an index atomically.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(backend): Merchant + PaymentIntent models (watch-only enforced)"`

---

### Task 8: Explorer HTTP client (txid verification — addressindex is OFF)

> **Finding (2026-07-18, probed live):** `GET https://explorer.fairco.in/api/address/:a` exists but the node returns `"addressindex not enabled … limited data available"` (all zeros) — so we **cannot** scan an address for received funds. `GET /api/transaction/:txid` **does** work. Therefore settlement is confirmed by the **payer reporting the broadcast txid**, which the backend verifies on-chain. This stays non-custodial (payer signs+broadcasts; backend only reads). Enabling addressindex on the Explorer node is a separate fix-upstream robustness upgrade, not required for F1A.

**Files:** Create `packages/backend/src/services/explorer.ts`, `config.ts`; Test `…/__tests__/explorer.test.ts`

**Interfaces:** Produces:
- `getTip(network): Promise<number>` — `GET /api/stats?network=` → `stats.blockHeight` (confirmed in FAIRWallet `market.ts`).
- `getTransaction(txid, network): Promise<ExplorerTx | null>` where `ExplorerTx = { txid: string; confirmations: number; outputs: { address: string; valueSat: bigint }[] }` — `GET /api/transaction/:txid?network=`. Map the Explorer's output shape to `{ address, valueSat }`; return `null` on 404/not-found.
- `verifyPayment(tx, address, expectedSat): { paid: boolean; confirmations: number }` — pure helper: true iff some output pays `address` with `valueSat >= expectedSat`.

- [ ] **Step 1: Pin the `/api/transaction/:txid` response shape.** `curl -s "https://explorer.fairco.in/api/transaction/<a-real-testnet-or-mainnet-txid>?network=…"` and record the exact JSON path to outputs (address + value) in a comment. (Mainnet has live txids; testnet may be empty.)
- [ ] **Step 2: Failing test** — mock `fetch`; `getTip` parses `stats.blockHeight`; `getTransaction` maps outputs to `{address, valueSat: bigint}` and returns `null` on 404; `verifyPayment` returns `paid:true` only when an output matches address + `valueSat >= expectedSat`.
- [ ] **Step 3: Run — FAIL.**
- [ ] **Step 4: Implement** the client against the confirmed endpoints; `config.ts` reads `EXPLORER_BASE_URL` (default from `@fairco.in/core`), `PEABLE_NETWORK`, `MONGODB_URI`, `PORT`, Oxy app-key env — typed, no magic numbers.
- [ ] **Step 5: Run — PASS**, plus one **live mainnet** assertion (`getTip('mainnet') > 0`; testnet is currently empty so assert against mainnet).
- [ ] **Step 6: Commit.** `git commit -am "feat(backend): FairCoin Explorer client (tip + address received)"`

---

### Task 9: Settlement watcher (tip-driven, non-custodial)

**Files:** Create `packages/backend/src/services/settlementWatcher.ts`; Test `…/__tests__/settlementWatcher.test.ts`

**Interfaces:** Produces `class SettlementWatcher { start(): void; stop(): void; async check(): Promise<void> }`. On each Explorer tip advance (subscribe to the tip WS from `explorer.ts`, fallback interval with `.unref?.()`), for every `PaymentIntent` in `broadcast`/`confirming` **that has a submitted `txid`**: call `getTransaction(intent.txid)` then `verifyPayment(tx, intent.address, expectedSat)` → on `paid` with `confirmations < required` → `applyEvent('mempool_seen')` (`confirming`); with `confirmations >= required` → `applyEvent('confirmed')` (`settled`); if the tx pays a smaller amount → `applyEvent('underpaid')` (`failed`). Persist, then hand the changed intent to the injected socket emitter + webhook dispatcher (the watcher stays pure of transport).

- [ ] **Step 1: Failing test** — seed a `broadcast` intent with a `txid` + a stubbed `explorer.getTransaction` returning an output to the intent address with 0→1→N confirmations across calls; assert transitions `broadcast→confirming→settled`, an under-value output → `failed`, and that the injected `onChange` fires once per transition.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**; the interval fallback timer calls `timer.unref?.()`. No polling of settled/terminal intents.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(backend): non-custodial settlement watcher"`

---

### Task 10: Webhook dispatcher (safeFetch + retries)

**Files:** Create `packages/backend/src/services/webhookDispatcher.ts`; Test `…/__tests__/webhookDispatcher.test.ts`

**Interfaces:** Produces `deliver(event: WebhookEvent, merchant: Merchant): Promise<void>` — builds the `evt_` envelope, signs via `signWebhook(merchant.webhookSecret, …)`, POSTs through `safeFetch` (SSRF-safe) with the `Peable-Signature` header; retries with backoff; never throws into the watcher.

- [ ] **Step 1: Failing test** — a stub endpoint receives a correctly-signed POST (verify with `verifyWebhook`); a 500 triggers a retry; an SSRF target (`http://169.254.169.254`) is refused by `safeFetch`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** using `safeFetch` from `@oxy.so/core/server`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(backend): signed webhook dispatcher"`

---

### Task 11: REST routes — create / get / reject (serviceAuth + idempotency)

**Files:** Create `packages/backend/src/routes/paymentIntents.ts`; Test `…/__tests__/routes.test.ts`

**Interfaces:** `POST /v1/payment_intents` (merchant `serviceAuth`; `Idempotency-Key` required; validates body with `zod` against `CreatePaymentIntentParams`; `reserveNextAddress`; returns 201 `PaymentIntent` + `client_secret`). `GET /v1/payment_intents/:id`. `POST /v1/payment_intents/:id/reject`. `POST /v1/payment_intents/:id/submit_tx` — body `{ client_secret, txid }`; the payer proves possession of the intent via `client_secret` (constant-time compare, not merchant auth), sets `intent.txid`, and `applyEvent('broadcast')` so the watcher (Task 9) starts verifying it. This is the payer-reported-txid entry (addressindex is off — see Task 8).

- [ ] **Step 1: Failing test** (spin the express app + memory mongo): create returns a `pi_…` with a derived `address`; **replaying the same `Idempotency-Key` returns the same intent, not a second one**; missing auth → 401; bad amount → 422.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**; idempotency via a unique index on `(merchantId, idempotencyKey)` returning the existing intent on duplicate. Mount `oxyClient.serviceAuth()` on the router. No `new Model(req.body)` — explicit field whitelist.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(backend): payment-intent REST routes"`

---

### Task 12: Realtime — Socket.io intent updates

**Files:** Create `packages/backend/src/realtime/socket.ts`; Test `…/__tests__/socket.test.ts`

**Interfaces:** Produces `initSocket(httpServer)` (`io.use(oxy.authSocket())`) and `emitIntentUpdate(intent)` → room `intent:${intent.id}` and `merchant:${intent.merchantId}` (rooms derived server-side from the authed identity + the intent's own ids, never client-supplied).

- [ ] **Step 1: Failing test** — a client authed + joined to `intent:pi_x` receives an `intent.updated` payload when `emitIntentUpdate` runs; a client cannot join another merchant's room.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** with `authSocket()`; ownership-check before join.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit.** `git commit -am "feat(backend): realtime intent updates"`

---

### Task 13: Server wiring + end-to-end testnet smoke

**Files:** Create `packages/backend/src/server.ts`, `db.ts`; Test `…/__tests__/e2e.test.ts`

**Interfaces:** `server.ts` wires express (CORS `createOxyCors`, rate-limit `createOxyRateLimit`, `Peable-Version` response header, routes, JSON error handler), boots mongoose + the `SettlementWatcher`, and hands `emitIntentUpdate` + `webhookDispatcher.deliver` to the watcher as `onChange`.

- [ ] **Step 1: Failing e2e test** — with memory mongo + a stubbed Explorer: create an intent → drive the watcher through `confirming`→`settled` → assert a socket `intent.updated` AND a signed webhook were emitted, and that **no key/seed field exists anywhere on the Merchant/PaymentIntent docs** (non-custody assertion).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `server.ts` + `db.ts`; error handler returns Stripe-shaped `{ error: { type, message } }`.
- [ ] **Step 4: Run — PASS.** Then a **manual live-testnet run** (documented in the test file header): register a merchant with a real testnet xpub, `POST /payment_intents`, pay the returned address from a testnet wallet, watch it reach `settled` and the webhook fire.
- [ ] **Step 5: Commit.** `git commit -am "feat(backend): server wiring + e2e settlement flow"`

---

## Self-Review

**Spec coverage:** non-custody invariant → enforced in Tasks 4/7/13 (guards + assertion); realtime → Task 12; Stripe parity (ids/idempotency/version/HMAC/client_secret) → Tasks 3/6/10/11/13; xpub+per-intent address → Tasks 4/7/11; Explorer watch-only → Tasks 8/9; webhooks → Tasks 6/10; SDK-57 align + fork + OxyProvider + approve-pay UI → **Track B (separate plan, gated on the FAIRWallet ref)**; POS/SDK → later phases. F1A covers the entire Gateway backend + contract.

**Out of this plan (follow-on):** Track B (wallet: subtree + monorepo wiring + SDK 57 + OxyProvider + approve-pay screen), Track C (end-to-end wallet↔gateway integration), then F2/F3/F4.

**Placeholder scan:** the two intentional verification points (Task 8 Explorer address endpoint; Task 4 xpub vector) are explicit `bun run`/`curl` steps, not placeholders. No `TODO`/`TBD` in deliverable code.

**Type consistency:** `PaymentIntentStatus`, `isValidStatusTransition`, `deriveIntentAddress(xpub,change,index,network)`, `getAddressReceived`, `emitIntentUpdate`, `signWebhook` names are used consistently across tasks.

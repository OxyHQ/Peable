# Notifications — Explorer Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a watch-only push-notification service to the FairCoin `Explorer` backend so it can alert wallets of on-chain payments while their app is closed.

**Architecture:** Reuse the existing `BlockchainMonitor` (already processes every new block). Wallets register a watch-only account xpub + gap limit; the server derives their FairCoin P2PKH addresses, matches them against each block's tx outputs, advances the gap-limit window, and dispatches **silent** FCM/APNS pushes carrying only a `txid`. No amounts/addresses in the payload; no key can ever spend.

**Tech Stack:** Express 5, `ws`, vitest. New: `@scure/bip32` + `@scure/base` (address derivation), FCM HTTP v1 (`google-auth-library` for the OAuth token), APNS token auth (`.p8` via `jsonwebtoken` + HTTP/2).

## Global Constraints

- Repo: `~/FairCoinWorkspace/Explorer`. Test runner: `vitest run` (`bun run test`).
- Package manager: **bun**. Install with `bun add`; commit `bun.lock` in the same commit as `package.json`.
- FairCoin derivation: BIP44 `m/44'/119'/0'/{0,1}/i`, **P2PKH base58check**. Mainnet/testnet pubkeyhash version bytes come from the Explorer's existing network constants (grep `shared/` / `server/lib` for the version byte; do NOT hardcode a new one).
- Secrets via `process.env` only — never commit FCM/APNS credentials (AGENTS.md secrets rule).
- Push payloads MUST NOT contain amounts, addresses, balances, or user identifiers — only an opaque `subscriptionId` + `txid`.
- No `any`, no `@ts-ignore`, no silent `catch {}` — this repo is TypeScript-strict like the rest.

---

### Task 1: Address-derivation util + models

**Files:**
- Create: `server/lib/notifications/derive.ts`
- Create: `server/lib/db/models/NotificationSubscription.ts`
- Create: `server/lib/db/models/WatchedAddress.ts`
- Test: `server/lib/notifications/derive.test.ts`

**Interfaces:**
- Produces: `deriveWindow(xpub: string, chain: 0 | 1, from: number, count: number, network: "mainnet" | "testnet"): { index: number; address: string }[]`
- Produces (models): `NotificationSubscription`, `WatchedAddress` models with the fields in the spec §4.3.

- [ ] **Step 1: Write failing test** — derive index 0 of the receive chain from a known test xpub and assert it equals the address the wallet produces for the same xpub. Obtain the vector from FAIRWallet: run its `KeyManager.fromXpub(xpub).getAddress(0)` for a fixed test xpub and paste the expected address into the test. Include one testnet vector.

```ts
import { describe, it, expect } from "vitest";
import { deriveWindow } from "./derive";

describe("deriveWindow", () => {
  it("derives FairCoin P2PKH receive addresses matching the wallet", () => {
    const xpub = "<fixed test account xpub m/44'/119'/0'>";
    const [first] = deriveWindow(xpub, 0, 0, 1, "mainnet");
    expect(first).toEqual({ index: 0, address: "<expected addr from wallet>" });
  });
  it("derives a contiguous window", () => {
    const xpub = "<fixed test account xpub>";
    const w = deriveWindow(xpub, 1, 5, 3, "mainnet");
    expect(w.map((x) => x.index)).toEqual([5, 6, 7]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails** — `bun run test server/lib/notifications/derive.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `derive.ts`** — `HDKey.fromExtendedKey(xpub)` (public-only), `.deriveChild(chain).deriveChild(i)`, hash160 the compressed pubkey, base58check-encode with the network pubkeyhash version byte (imported from the Explorer's existing network config). Reuse the repo's hash160/base58 helpers if present (grep first); otherwise `@noble/hashes` sha256+ripemd160 + `@scure/base` base58check.

- [ ] **Step 4: Run test, verify pass.**

- [ ] **Step 5: Implement the two models** — `NotificationSubscription` ({ subscriptionId (unique), xpub, scriptType, gapLimit, network, deviceToken, platform, confirmations, events[], derivedTo:{receive,change}, createdAt, lastSeenAt }); `WatchedAddress` ({ address (indexed), subscriptionId, chain, index }, compound unique on {subscriptionId,chain,index}). Follow the existing model style in `server/lib/db/models/Transaction.ts`.

- [ ] **Step 6: Commit** — `git add` the four files + `bun.lock` if deps added; `git commit -m "feat(notifications): xpub address derivation + subscription models"`.

---

### Task 2: Registration route

**Files:**
- Create: `server/routes/notifications.ts`
- Modify: `server/index.ts` (mount `app.use("/api/notifications", notificationsRouter)`)
- Test: `server/routes/notifications.test.ts`

**Interfaces:**
- Consumes: `deriveWindow`, both models from Task 1.
- Produces: `POST /api/notifications/register` and `DELETE /api/notifications/register` per spec §4.1.

- [ ] **Step 1: Write failing test** — POST a valid body → 200 with `subscriptionId` + `watchedTo`; assert `WatchedAddress` docs were created for `gapLimit` receive + change entries. POST a malformed xpub → 400. Use `supertest` against the Express app (grep existing route tests for the harness).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement route** — validate `{ xpub, scriptType, gapLimit, network, deviceToken, platform, confirmations, events }` (reject bad xpub via a try/catch around `deriveWindow`, cap `gapLimit` ≤ 100, whitelist `events`, whitelist `network`); generate an opaque `subscriptionId` (`crypto.randomUUID()`); upsert the subscription; derive `[0..gapLimit)` for chains 0 and 1 and bulk-insert `WatchedAddress`; return `watchedTo`. `DELETE` removes the subscription + its watched addresses. Apply the existing `express-rate-limit` limiter.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(notifications): register/unregister route"`.

---

### Task 3: BlockchainMonitor match + gap-limit advancement + push enqueue

**Files:**
- Create: `server/lib/notifications/matcher.ts`
- Modify: `server/lib/blockchain-monitor.ts` (call the matcher when a block is processed)
- Test: `server/lib/notifications/matcher.test.ts`

**Interfaces:**
- Consumes: models + `deriveWindow` (Task 1), `dispatchPush` (Task 4 — import the type; wire the real impl in Task 5).
- Produces: `matchBlock(block: ParsedBlock, deps: { dispatch: PushDispatcher }): Promise<void>` and `advanceWindow(subscriptionId, chain, usedIndex, gapLimit, xpub, network)`.

- [ ] **Step 1: Write failing test** — build a synthetic block with one tx output paying a watched address at receive index 3; call `matchBlock` with a mock dispatcher; assert the dispatcher was called once with `{ subscriptionId, txid, event: "incoming_pending" }` and that `advanceWindow` extended `WatchedAddress` up to `3 + gapLimit`. Second test: a tx spending a previously-watched output → `event: "outgoing_confirmed"`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement `matcher.ts`** — for each tx: look up each output address in `WatchedAddress`; on a receive-chain hit, enqueue `incoming_pending` (mempool/first-seen) or `incoming_confirmed` (in a mined block, depth ≥ subscription.confirmations) and call `advanceWindow` (derive up to `usedIndex + gapLimit`, bulk-insert new `WatchedAddress`, bump `derivedTo`); detect wallet-output spends for `outgoing_confirmed`. Dedup so one tx→one push per event per subscription (cap borrowed from the monitor's existing per-block cap constant).

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Wire into `blockchain-monitor.ts`** — in the new-block handler (and mempool handler if present), call `matchBlock`. Guard behind `if (notificationsEnabled)` (env). Do not block or throw into the monitor's main loop — wrap and log.

- [ ] **Step 6: Commit** — `git commit -m "feat(notifications): block matcher + gap-limit advancement"`.

---

### Task 4: Push dispatch (FCM v1 + APNS)

**Files:**
- Create: `server/lib/push/fcm.ts`, `server/lib/push/apns.ts`, `server/lib/push/index.ts`
- Test: `server/lib/push/index.test.ts`

**Interfaces:**
- Produces: `type PushDispatcher = (sub: NotificationSubscription, msg: { txid: string; event: string }) => Promise<void>`; `createDispatcher(config): PushDispatcher`.

- [ ] **Step 1: Write failing test** — with mocked FCM + APNS senders, dispatch to an `android` subscription → FCM sender called with a **data-only** message whose payload keys are exactly `{ txid, event, subscriptionId }` and **no amount/address**. Dispatch to `ios` → APNS called with `content-available: 1` and no alert body containing an amount. On a `NotRegistered`/`Unregistered` error → subscription's token is pruned (subscription deleted or token cleared).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — `fcm.ts`: FCM HTTP v1, OAuth via `google-auth-library` from `FCM_SERVICE_ACCOUNT_JSON`, send `{ message: { token, data: { txid, event, subscriptionId }, android: { priority: "high" } } }`. `apns.ts`: HTTP/2 to APNS, JWT (`ES256`, `.p8`, `APNS_KEY_ID`/`APNS_TEAM_ID`), `apns-push-type: background`, `content-available: 1`, topic `APNS_BUNDLE_ID`. `index.ts`: pick by `platform`, map dead-token errors → prune.

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(notifications): FCM + APNS silent-push dispatch"`.

---

### Task 5: Startup wiring + integration test + config

**Files:**
- Modify: `server/index.ts` (construct `createDispatcher` from env, pass into the monitor/matcher)
- Create: `server/lib/notifications/config.ts` (`notificationsEnabled`, reads env; disabled if creds absent)
- Create: `.env.example` entries (documented, no secret values)
- Test: `server/lib/notifications/integration.test.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write failing integration test** — register a subscription via the route → feed a synthetic block paying its index-0 address through the monitor hook with a mock dispatcher → assert exactly one silent push with only `{ txid, event, subscriptionId }`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement config + wiring** — `notificationsEnabled` true only when `FCM_SERVICE_ACCOUNT_JSON` (and/or APNS vars) are present; otherwise the whole feature is an inert no-op (Phase-1-safe). Add env docs to `.env.example`: `FCM_SERVICE_ACCOUNT_JSON`, `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENV`.

- [ ] **Step 4: Run, verify pass. Run the full suite** — `bun run test` → all green.

- [ ] **Step 5: Commit** — `git commit -m "feat(notifications): wire dispatcher + config, integration test"`.

---

## Self-Review

- **Spec coverage:** §4.1 register → Task 2; §4.3 models/monitor/dispatch/config → Tasks 1,3,4,5; §4.2 silent payload → Task 4; §5 payload minimization → Task 4 test asserts no amount; addressindex-not-required → matcher scans block outputs (Task 3). Covered.
- **Type consistency:** `PushDispatcher` defined in Task 4, referenced by type in Task 3, wired in Task 5. `deriveWindow` signature identical across Tasks 1/2/3.
- **Deferred (roadmap, not this plan):** price/masternode/deep-confirm events (spec §3 optional).

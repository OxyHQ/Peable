# Design — Background payment notifications for FAIRWallet

- **Date:** 2026-07-16
- **Status:** Approved (design), pending spec review → implementation plan
- **Scope:** Two codebases (Explorer backend + FAIRWallet app) + push infra (FCM/APNS)
- **Repos:** `~/FairCoinWorkspace/Explorer` (backend), `~/FairCoinWorkspace/FAIRWallet` (app)

## 1. Context & problem

FAIRWallet is a **non-custodial SPV wallet**: keys live on-device (SecureStore, hardware-backed),
it talks to FairCoin P2P peers directly (`src/p2p/spv-client.ts`), and it does **not** use the
Explorer today. Because the SPV client lives in the React/JS runtime, sync stops when the app is
backgrounded/closed, so the user gets **no "you received X" alert while the app is closed**.

Continuous on-device background sync (a foreground service) is battery-hostile, **impossible on
iOS** when the app is closed, and is **not** what professional wallets do. Custodial/top wallets
(Coinbase, Trust, MetaMask) and serious non-custodial ones (Muun, Phoenix, Blockstream Green) all
use the same pattern: **a server watches the chain and sends a push notification**; the phone stays
asleep until an actual event wakes it.

FAIRWallet already has the server it needs in the workspace: **`Explorer`** — an Express 5
+ `ws` service with a `BlockchainMonitor` that already processes every new block, address routes,
and a websocket manager. It only lacks a push-subscription layer.

## 2. Goals / non-goals

### Goals
- Notify the user of wallet activity **while the app is closed**, on **iOS and Android**.
- **Non-custodial preserved**: the server never sees a private key and can never spend. Watch-only.
- **Privacy is a first-class, user-controlled dial**, not an afterthought.
- **No amounts/addresses transit Google/Apple** — notification text is composed on-device.
- Reuse the existing Explorer infrastructure; no new standalone service.
- Professional, standard, robust — **no fragile "register-as-you-go" schemes** that can drop a payment.

### Non-goals
- Continuous on-device chain sync in the background (rejected: battery + iOS-impossible).
- A probabilistic bloom-filter push scheme (rejected: high complexity for only statistical privacy).
- Custody, accounts, or any server-held key material.

## 3. Notification catalog

"Everything a wallet like FAIRWallet should have." Split into what we build now vs. designed-and-deferred.

### Core (build now — Phases 1–2)
| # | Event | Trigger | Text (composed on-device) |
|---|-------|---------|---------------------------|
| 1 | **Incoming payment (pending)** | A tx paying a watched address is first-seen (0-conf / mempool) | "Recibiendo X FAIR…" |
| 2 | **Incoming payment confirmed** | That tx reaches N confirmations (default 1, configurable) | "Recibiste X FAIR" + `received` sound |
| 3 | **Outgoing payment confirmed** | A tx spending the wallet's UTXOs reaches 1 conf | "Tu envío de X FAIR se confirmó" |

### Already built (keep)
| # | Event | Where |
|---|-------|-------|
| 4 | **Sync status (ongoing)** | `sync-notifier.ts` → LOW channel, updates on % and block-height ticks |
| 5 | **Foreground received sound** | `sounds.ts` `received.mp3` when a tx arrives with app open |

### Optional / roadmap (designed, deferred — YAGNI now)
| # | Event | Notes |
|---|-------|-------|
| 6 | **Deep-confirmation reached** | e.g. "6 confirmaciones — liquidado". Configurable depth. Trivial extension of #2. |
| 7 | **Price alerts** | FAIR moved ±X%. Explorer already has `Price`/`PricePoint` models + price route. Opt-in, server-side. |
| 8 | **Masternode alerts** | FairCoin-specific: masternode status change / reward credited. Wallet has a masternode screen. |
| 9 | **Security: repeated failed PIN** | Local-only notification (no server). Wallet already has exponential back-off state. |

Each optional item is additive on the same architecture; none changes the core design.

## 4. Architecture

### 4.1 Registration model — watch-only account xpub + gap limit (industry standard)

The wallet registers its **watch-only account key** (`m/44'/119'/0'` xpub, already exposed by
`KeyManager`) plus a **gap limit**. The server derives and watches the receive (`.../0/*`) and
change (`.../1/*`) chains itself.

**Why xpub, not an address list:** with push, the client is *offline* when the payment lands. If the
server doesn't own the gap-limit logic, a payment to a not-yet-registered address is a **missed
notification** — exactly the fragility we forbid. The xpub is **watch-only** (BIP32 public
derivation): it cannot sign or spend. Privacy exposure of the xpub is handled by the privacy modes
(§4.4), not by weakening robustness.

**FairCoin note:** we do **not** ship a literal Bitcoin output-descriptor string, because address
encoding is FairCoin-specific (P2PKH, base58check, FairCoin version bytes). The registration payload
is descriptor-*equivalent* structured data; the Explorer (already FairCoin-aware) derives pubkeys via
BIP32 and encodes P2PKH addresses with the correct network version. Registration payload:

```jsonc
POST /api/notifications/register
{
  "xpub": "<account xpub at m/44'/119'/0'>",
  "scriptType": "p2pkh",       // FairCoin standard
  "gapLimit": 20,              // BIP44 default; server may widen
  "network": "mainnet",        // or "testnet"
  "deviceToken": "<native FCM/APNS token>",
  "platform": "android" | "ios",
  "confirmations": 1,          // depth for "confirmed" notifications
  "events": ["incoming_pending", "incoming_confirmed", "outgoing_confirmed"]
}
→ 200 { "subscriptionId": "<opaque id>", "watchedTo": { "receive": 25, "change": 25 } }
```

`DELETE /api/notifications/register` `{ subscriptionId }` — logout / notifications off / token rotation.

The `deviceToken` is a rotating device secret; the `subscriptionId` is opaque. No wallet identifier,
no PII.

### 4.2 Transport — direct FCM/APNS, silent push → on-device enrichment → local notification

The privacy-preserving pattern used by Signal and serious wallets:

1. Server sends a **data-only / silent push** carrying only an opaque wake signal + `txid`
   (no amount, no address, no human-readable text).
2. The phone **wakes the app headless**, syncs that `txid` locally (from the Explorer read API or
   its own SPV), computes the amount, and **posts a local notification** (`scheduleReceivedNotification`,
   reusing the `transactions` channel + `received.mp3`).
3. **Google/Apple/FCM never see amounts or addresses** — the visible text is built on the device.

- **Android:** FCM **data message**, high priority → Expo `expo-notifications` background handler /
  headless task → local notification.
- **iOS:** APNS `content-available: 1` silent push. Because iOS throttles pure-silent pushes, the
  robust variant is a low-priority **alert push with generic text** ("Nueva actividad") + a
  **Notification Service Extension** that fetches the `txid` and rewrites the notification body
  on-device before display. Amount is never in the APNS payload.

**Direct FCM/APNS** (not Expo's push relay) removes a third party from the chain. The wallet obtains
the native token via `Notifications.getDevicePushTokenAsync()` (FCM on Android, APNS on iOS).

### 4.3 Explorer backend responsibilities

Reuses existing components; new pieces marked **NEW**.

- **NEW model** `NotificationSubscription` (`server/lib/db/models/`): `{ subscriptionId, xpub,
  scriptType, gapLimit, network, deviceToken, platform, confirmations, events, derivedTo:{receive,change},
  createdAt, lastSeenAt }`.
- **NEW model / index** `WatchedAddress`: `{ address, subscriptionId, chain, index }` — indexed by
  `address` for O(1) match per block output.
- **NEW routes** `server/routes/notifications.ts`: `POST`/`DELETE /register` (validate xpub, derive
  gap-limit window, upsert subscription + watched addresses, rate-limited via existing
  `express-rate-limit`).
- **`BlockchainMonitor` hook (extend)**: it already fetches and processes each new block. On each
  block, for every tx: match output addresses against `WatchedAddress`; on a hit → (a) if a watched
  receive address at index `i` is used, **advance the gap-limit window** (derive up to `i+gapLimit`);
  (b) enqueue a push for the matched subscription(s). Match spends of previously-seen wallet outputs
  for `outgoing_confirmed`. Mempool/first-seen handling for `incoming_pending` (the monitor's
  mempool source; degrade gracefully if the node lacks mempool visibility).
- **NEW dispatch** `server/lib/push/` — a thin FCM (HTTP v1) + APNS (token-based, `.p8`) sender.
  Silent/data payloads only. Prune tokens on `UNREGISTERED`/`InvalidRegistration`.
- **Config (`process.env`, secrets never in repo):** `FCM_SERVICE_ACCOUNT_JSON` (or path),
  `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENV`. Public base already
  `explorer.fairco.in`.

Matching scans block tx outputs directly (the monitor already has full blocks), so **addressindex
is not required** for notifications (it stays required only for the existing balance/UTXO read API).

### 4.4 Privacy modes — one architecture, a server-URL dial

No second backend. The "privacy mode" is *which server you trust*, configured in Settings:

| Level | How | What the server learns |
|-------|-----|------------------------|
| **Default** | Official Explorer (`explorer.fairco.in`) | Your account xpub (watch-only) |
| **High** | **Your own Explorer** (self-host `FAIRNode` + `Explorer`; set the URL in Settings) | Nothing — it's yours |
| **Maximum** | **Off** (toggle) | Nothing — no registration; alerts only while the app is open |

This mirrors Sparrow/Samourai-Dojo ("run your own node"). It is honest and reuses 100% of the design.

### 4.5 Wallet app responsibilities

- **Token:** `getDevicePushTokenAsync()` after permission grant.
- **Registration lifecycle:** on unlock with notifications ON → register `{ xpub, gapLimit, token,
  confirmations, events }` at the configured server URL. Re-register on token rotation, on
  confirmation-depth change, and on wallet switch. `DELETE` on notifications-off / wallet delete /
  logout.
- **Silent-push handler:** background handler → sync `txid` → local notification via the existing
  `notifications.ts` (channel + `received.mp3`). Reuses the `transactions` channel and the
  `data.type` handler split already in place.
- **Settings (NEW):** a "Notificaciones de pago" section — master toggle, **server URL** field
  (default `explorer.fairco.in`, editable), confirmation depth, and per-event switches (§3 core).
- **Watch-only reuse:** the xpub comes from `KeyManager` (already supports `fromXpub` and exposes the
  account key); registration needs **no private key** and works even while the wallet is PIN-locked.

## 5. Security considerations

- **No spend capability ever leaves the device.** Only the watch-only xpub is registered; signing
  stays gated behind PIN unlock.
- **Payload minimization:** silent pushes carry only `txid` + opaque subscription ref. No amounts,
  addresses, balances, or user identifiers transit FCM/APNS.
- **Server secrets** (FCM service account, APNS `.p8`) live in `process.env` on the Explorer host,
  never in the repo (per AGENTS.md secrets rule).
- **Rate limiting + validation** on `/register` (reuse `express-rate-limit`); reject malformed xpubs,
  wrong-network keys, oversized gap limits.
- **Token hygiene:** prune dead tokens on provider `UNREGISTERED`; `subscriptionId` is opaque and
  revocable.
- **Self-host escape hatch** for users who won't trust a third party with address linkage.

## 6. Error handling & degradation

- Registration failure (network/permission) is non-fatal: the app keeps working; foreground sync
  notifications still fire. Retry with backoff on next unlock.
- iOS silent-push throttling: the NSE + generic-alert fallback guarantees delivery without leaking
  content.
- Node without mempool visibility: `incoming_pending` degrades to confirmed-only; no crash.
- Provider outage: pushes are best-effort; on app open, normal SPV sync reconciles the true state
  (push is an *alert*, never the source of truth).
- Off / self-host with server unreachable: silent no-op, foreground notifications unaffected.

## 7. Testing

- **Explorer unit:** gap-limit derivation & advancement (FairCoin P2PKH encoding), address-match on a
  synthetic block, subscription upsert/delete, dead-token pruning, payload contains **no** amount.
- **Explorer integration:** register xpub → mine/inject a tx paying a derived address → assert a
  silent push is dispatched with only `txid`.
- **Wallet unit:** registration payload shape, token acquisition, silent-push handler builds correct
  local notification, settings toggle/URL wiring, off-mode sends `DELETE`.
- **Device E2E (Pixel):** register → send FairCoin to a receive address with the app **closed** →
  phone wakes → local notification with correct amount + `received.mp3`; verify FCM payload (server
  logs) has no amount/address.

## 8. Implementation phases

1. **Explorer backend** — models, `/notifications/register`, `BlockchainMonitor` match + gap-limit
   advancement, FCM/APNS dispatch, config. Ships behind env flags; safe no-op if unconfigured.
2. **Wallet integration** — native token, registration lifecycle, silent-push handler, Settings
   (toggle + server URL + depth + per-event), iOS NSE.
3. **Infra + E2E** — Firebase project (`google-services.json`, FCM v1 service account), APNS `.p8`
   key, end-to-end verification on the Pixel; then iterate optional catalog items (§3: price,
   masternode, deep-confirm) as follow-ups.

Each phase is independently shippable; Phase 1 is inert until Phase 3 provisions credentials.

## 9. Infra the user must provision (guided)

- **Firebase project** → `google-services.json` (Android app `in.fairco.wallet`) + a **service
  account JSON** for FCM HTTP v1.
- **APNS** → an auth key `.p8` + Key ID + Team ID + bundle id, for iOS.
- Both configured as Explorer server env vars; nothing committed.

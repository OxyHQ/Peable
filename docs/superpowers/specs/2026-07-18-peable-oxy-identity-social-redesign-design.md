# Peable — Oxy-Identity Wallet, Social Send & Pockets (Redesign)

> **Status:** Design (brainstorming output) — pending user review, then `writing-plans`.
> **Date:** 2026-07-18
> **Supersedes/refines:** parts of `2026-07-18-peable-phase1-foundation-design.md` (the self-custodial + Oxy-identity foundation) with a concrete product model.

## 1. Vision

Peable is the FairCoin money app of the Oxy ecosystem: **you sign in with your Oxy account and your money is just there** — no seed-phrase onboarding, no "create wallet" wall. Sending is **social first** (pay a person by `@username`, Revolut-style); paying a raw FairCoin address is the secondary option. Balances are organised with **Pockets** (Revolut-style sub-balances). Unlike FAIRWallet (a standalone, device-local, multi-wallet SPV wallet with `in.fairco.wallet`), Peable (`to.peable.app`) is **account-centric**: one wallet, bound to your Oxy self-sovereign identity.

## 2. Non-negotiable invariants

1. **100% self-custody (MiCA legal firewall).** The user's FairCoin private keys are derived and held **only on the user's device**; the backend and Oxy servers NEVER see, hold, or can reconstruct a spending key or custody funds. Only the identity holder can spend. This is the legal basis (avoids CASP licensing) and MUST NOT be weakened.
2. **Keys never leave the device.** Identity/derived keys live in Keychain/SecureStore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`, hardware-backed where available). Spending requires device unlock + app PIN/biometric.
3. **Security review before mainnet.** The derivation scheme (esp. the identity-key-derived social-receive branch) MUST pass a `security-reviewer` audit before any mainnet build ships. No "100% unhackable" claims — standard self-custody threat model applies and is documented in §10.
4. **Fix upstream, never patch the consumer.** Generic wallet-core work (Pockets) is implemented in **FAIRWallet upstream** and pulled into Peable via `git subtree pull`. Generic identity-key access (identity→seed via `deriveScopedSeed`, raw key via `getPrivateKey`/`getSharedPrivateKey`) lives in `@oxy.so/core` (platform-agnostic, MUST NOT import faircoin). FairCoin-specific crypto (the identity-pubkey→FairCoin social-receive address derivation) lives in **`@fairco.in/core`** (generic secp256k1 inputs, no Oxy dep). Only Oxy-specific product code (onboarding, social send UI, identity wiring, the glue) diverges in Peable.

## 3. Scope & decomposition

Three workstreams, sequenced. Each is independently testable.

- **WS-P — Pockets (FAIRWallet upstream).** Parametrise the wallet by BIP44 account index; Pockets UI. Generic, reusable, no Oxy dependency. Lands in FAIRWallet → subtree-pulled into Peable.
- **WS-F — Foundation: Oxy-identity wallet + Oxy-first onboarding (Peable + `@oxy.so/core`).** Replace the `hasWallet()` onboarding with sign-in-with-Oxy; derive the single wallet from the Oxy identity; handle keyless accounts.
- **WS-S — Social send/receive + rich transaction identity (Peable + backend + `@oxy.so/core`).** `@username` payments: resolve → derive → send; social-receive address scheme; user-search UI; raw-address send kept as secondary. PLUS the transaction history showing merchant name+logo / user avatar+name per §4.8 (the Stripe/Revolut-grade ledger — enrichment service + attribution records).

**Out of scope (this design):** fiat on-ramp, invoices/subscriptions/payment-links (Gateway phase 2), Terminal/NFC, web wallet (native-only — see §9), swapping FairCoin↔fiat.

## 4. Component design

### 4.1 Identity-derived wallet (WS-F)

The FairCoin HD wallet seed is derived on-device from the Oxy self-sovereign identity key (secp256k1), never from a separate BIP39 mnemonic the user must write down.

**Derivation recipe (spending tree):**
```
identityPrivKey (32 bytes, from KeyManager)                       // @oxy.so/core, on-device only
seed = hkdfSha256(ikm = identityPrivKey,
                  salt = SDK-fixed salt,
                  info = utf8("peable/faircoin/v1"),
                  length = 32)                                     // domain-separated
hd   = KeyManager.fromSeed(seed, network)                         // Peable wallet key-manager
                                                                  // = HDKey.fromMasterSeed(seed); m/44'/119'/account'/…
```
- `hkdfSha256` already exists (`@oxy.so/core` `crypto/kdf.ts`); the pattern mirrors `RecoveryPhraseService.deriveBackupMaterial`.
- `KeyManager.fromSeed` already accepts an arbitrary 32-byte seed (`@scure/bip32` `HDKey.fromMasterSeed`, 256-bit advised). **Do NOT** route HKDF output through `mnemonicToSeed` (BIP39 doesn't validate input → silently wrong seed; footgun already flagged in `wallet-store.ts`).
- FairCoin coin type: mainnet `44'/119'`, testnet `44'/1'`.
- This spending tree is **private**: its addresses are NOT publicly derivable (privacy for the user's own balance/change/pockets).

**Where the identity key comes from (native-only):**
- Peable reads the identity key from the **shared keychain** `group.so.oxy.shared` (`KeyManager.getSharedPrivateKey()`), the ecosystem SSO mechanism written by Commons. Peable MUST ship the shared-keychain entitlement (iOS `keychain-access-groups` incl. `group.so.oxy.shared`, same Team ID; Android `sharedUserId="so.oxy.shared"` + the shared Oxy release keystore).
- **Cleaner API (upstream, fix de raíz):** add `KeyManager.deriveScopedSeed(info: string): Promise<Uint8Array>` to `@oxy.so/core` so Peable never handles the raw identity private key — it asks the SDK for a domain-separated 32-byte seed. The SDK does the HKDF internally.
- On web the identity key is `null` → no wallet (see §9).

**Keyless (custodial) Oxy accounts:** detect via `oxy.listAuthMethods()` / `resolveDid()` (no `identity` verification method) or on-device `hasSharedIdentity()`/`hasIdentity()`. If the user has no self-sovereign identity, onboarding routes them to **create one** (Commons handoff, or in-app `@oxy.so/core` `RecoveryPhraseService.generateIdentityWithRecovery()` + `oxy.linkIdentityKey()`), surfacing the Oxy recovery phrase. Only after an identity exists can a wallet be derived.

### 4.2 Onboarding (WS-F)

Replace the `hasWallet()`-gated flow. New entry decision in `app/index.tsx`:

```
if (!oxySignedIn)            -> "Sign in with Oxy"        (OxyAccountDialog / OxySignInButton)
else if (!hasOxyIdentity)   -> "Set up your Oxy ID"      (Commons handoff / in-app create)
else                        -> derive wallet, go to (tabs)/home
```
- Removed from the default path: `onboarding/welcome` (Create/Restore), `onboarding/create` (seed generation + verify quiz), `onboarding/restore`. Seed-phrase UX is **not** the first thing shown; the Oxy recovery phrase IS the backup.
- The "Back up your wallet" banner becomes "Your recovery is your Oxy recovery phrase" (managed in Commons) — no separate FairCoin seed.
- The root `<Stack>` is the sole authority for the `(auth)`↔`(tabs)` swap (expo-router rule); child screens render a neutral backdrop.

### 4.3 Social identifiers & addresses (WS-S)

**`@username` is the permanent, primary way to receive.** It never changes; it is what people save as a favourite. Under it sit real on-chain addresses derived from the user's identity, so a payer needs only the recipient's **public** identity.

**Social-receive derivation (the novel, security-critical scheme):**
```
IK_pub  = recipient identity secp256k1 pubkey (compressed), from DID publicKeyHex (resolveDid)
IK_priv = recipient identity private key (recipient only)
cc      = HMAC-SHA256(key = "peable/faircoin/social/v1", msg = IK_pub)      // deterministic chain code, PUBLIC
xpub_social = HDKey{ publicKey: IK_pub,  chainCode: cc, depth: 0 }          // payer can build (public info only)
xprv_social = HDKey{ privateKey: IK_priv, chainCode: cc, depth: 0 }         // recipient can build (holds IK_priv)
addr(i) = publicKeyToAddress( xpub_social.deriveChild(i).publicKey, network )   // non-hardened
```
- `addr(0)` = **stable default / favourite address** — always the same, shareable as a raw FairCoin address (for exchanges/external wallets that don't know Oxy usernames).
- `addr(1), addr(2), …` = **fresh addresses**, one per social payment (privacy: social receipts aren't all linkable to one address).
- The **payer** derives `addr(i)` from the recipient's public identity alone — no interaction, no recipient onboarding required. The **recipient** derives the matching private keys from `IK_priv` and spends. **Fully self-custody**; funds sit on-chain at the recipient's own address from the moment of send.
- **Index selection = backend, reusing the Gateway.** To pick a fresh unused index without the payer scanning the chain, Peable asks the backend for the next social-receive address for `@user` — the backend resolves `@user → IK_pub → xpub_social`, scans usage via the Explorer, and reserves the next unused index. This directly reuses the existing watch-only `reserveNextAddress`/`deriveIntentAddress`/PaymentIntent machinery, keyed to a **user's identity-derived xpub** instead of a merchant's published xpub. The backend only ever handles the **public** `xpub_social` — never a private key.
- **Recipient scanning:** Peable scans `xprv_social` children `0..gapLimit` (like normal HD receive) to find incoming social funds, in addition to its private spending tree.

**Key-separation note (for security review):** the private spending tree (§4.1) is HKDF-domain-separated from the identity key (no reuse). The social-receive branch, by requirement, uses the identity key's EC point directly (so payers can compute addresses from the public key) — this is the ONLY place the identity key is reused for money. Children are distinct BIP32 keys, but this reuse (DID signing + FairCoin) MUST be reviewed by `security-reviewer` (nonce-hygiene, cross-protocol signing). If review rejects it, fallback = require recipients to publish a dedicated FairCoin `xpub` once (loses "pay someone who never opened the app").

### 4.4 Social send flow (WS-S)

Primary flow (Revolut-style):
1. Search users: `oxy.searchProfiles(query)` / `getProfileByUsername` → pick `@user`.
2. Enter amount + optional note + choose Pocket (source).
3. App requests recipient's next social address from the backend (`@user → xpub_social → next addr`).
4. Approve (PIN/biometric) → existing `wallet-store.sendTransaction(address, amount, feeRate)` builds/signs/broadcasts (SPV/P2P today; may add gateway broadcast fallback).
5. Live status reuses the existing `pay/[intent]` + Socket.IO machinery where applicable.

Secondary flow: **"Send to FairCoin address"** — the current paste/scan address path, kept but demoted in the UI. Raw addresses stay valid.

### 4.5 Social receive (WS-S)

- Home shows your `@username` + your default address (`addr(0)`) with QR + copy + "save as favourite".
- Incoming social payments detected by scanning `xprv_social` children (§4.3).
- Payers who target a keyless recipient see "invite them to set up their Oxy ID / Peable" instead of a send (no public key to derive from).

### 4.6 Pockets (WS-P — FAIRWallet upstream)

Revolut-style sub-balances within one wallet, as **BIP44 account indices** (`m/44'/coin'/account'`), each a fully isolated BIP32 subtree with its own external/change branches, gap-limit cursors, xpub, and UTXO set.
- **Upstream change in FAIRWallet** `src/wallet/key-manager.ts`: thread an `account` parameter through `fromSeed`/`fromXpub`/`accountXpub`/`deriveAndStore` and the path string (currently hardcodes `account'=0` at `key-manager.ts:86,497,518`). The lower `@fairco.in/core` layer already accepts an `account` arg.
- **Upstream change in FAIRWallet** `wallet-store.ts`: the single-account module globals (one `keyManager`/`utxoSet`/`database`) become account-aware (partition UTXOs per pocket, or N managers).
- Moving funds between pockets = an ordinary on-chain self-transfer (send from pocket A to `getNextAddress()` of pocket B) — no new primitive; reuses `buildTransaction`.
- Pockets UI (list, create/rename/delete pocket, per-pocket balance, move-between) in FAIRWallet.
- **Peable** pulls this via subtree; its single identity-derived root seeds all pockets (`account'` under the identity-derived master). Peable hides FAIRWallet's multi-wallet switcher (§4.7) and surfaces Pockets instead.

### 4.7 Removed in Peable: multi-wallet

Peable is single-wallet. The FAIRWallet multi-wallet switcher (`app/wallets.tsx`, `WalletSwitcherSheet`, `createNewWallet`/`switchWallet` UI) is hidden/removed in Peable's divergence (the underlying multi-wallet code stays in the subtree, dormant). "Wallets" as a user concept is replaced by "Pockets".

### 4.8 Transaction identity & merchant display (WS-S) — Stripe/Revolut-grade history

The transaction list must show **who** each payment was with — a merchant's name + logo ("Paid at Mercaria"), or a user's avatar + display name ("Sent to @alice" / "Received from @bob") — not raw addresses + amounts. This is core to being "our own Stripe": the on-chain ledger only carries addresses + amounts, so counterparty identity is **payment metadata**, resolved off-chain, NOT derived from the address.

Three enrichment sources, each keyed to a transaction (txid) or address:

1. **Merchant payments (via Gateway PaymentIntent).** When a user pays a merchant through a payment link / hosted checkout / Terminal, the payment is a `PaymentIntent` carrying merchant metadata (name, logo/avatar file id, description, line items). The backend already stores this and knows the derived receive address + the submitted txid. The history renders "Paid at <merchant>" with the merchant logo, exactly like Stripe/Revolut — merchant identity comes from the PaymentIntent record, never from the chain.

2. **Outgoing social sends (pay @user).** When the user initiates "pay @alice", the app already resolved the recipient (§4.4), so it knows the Oxy `userId`. Persist the counterparty identity against the outgoing tx locally AND register it with the gateway (so it survives reinstall / shows cross-device). History renders "Sent to @alice" with her avatar.

3. **Incoming from a user.** An incoming on-chain tx to your address does not by itself reveal the sender. But when a sender pays you via the social-send flow, their app told the gateway it was paying you (the gateway minted/attributed the receive address for that payment), so the gateway attributes the incoming payment to `@sender` → history shows "Received from @bob" + avatar. A **pure external** on-chain payment (someone pays your address directly, not through Peable's social flow) shows the raw address with no identity — the honest equivalent of an unknown bank transfer in Revolut; the user can optionally label it.

**Enrichment service (backend + SDK).** A backend endpoint maps a batch of `{txid | address}` → `{kind: 'merchant'|'user'|'unknown', displayName?, avatarFileId?, username?, description?}`, sourced from PaymentIntents + social-send attribution records. The transaction list calls it (batched, cached) and renders identity via the **canonical Oxy media chokepoint** — Bloom `Avatar` fed a bare file id + `oxyServices.getFileDownloadUrl(id, variant)` resolver, display name via `name.displayName ?? handle` (never recomposed). No per-app avatar URL fields.

**Custody note:** this is display-only metadata; it never affects custody. Funds are still self-custody on-chain (§2.1); enrichment failing (offline / unknown counterparty) degrades gracefully to address + amount, never blocks a payment.

## 5. Upstream additions (fix de raíz)

**`@oxy.so/core` (platform-agnostic — NO FairCoin, NO new WS-S publish):**
- `KeyManager.deriveScopedSeed(info: string): Promise<Uint8Array>` — HKDF the identity key to a 32-byte, domain-separated seed without exposing the raw key (used by the identity WALLET, WS-F, already published).
- (Reuse existing) `getPrivateKey()`/`getSharedPrivateKey()` — the raw identity secp256k1 key the recipient's social-receive spending-key derivation needs (already exposed; no change). Plus `resolveDid`, `searchProfiles`, `getProfileByUsername`, `listAuthMethods`, identity-creation/link.

**`@fairco.in/core` (the social-receive helper lives HERE — FairCoin crypto, generic secp256k1 inputs, no Oxy dep; published):**
- A shared **identity → FairCoin social-receive** helper — `deriveSocialReceiveAddress(identityPubKeyHex, index, network)` (payer/backend, public) + `deriveSocialReceiveSpendingKey(identityPrivKeyHex, index, network)` (recipient, private) — building `xpub_social`/`xprv_social` + `addr(i)` from a NORMALIZED (compressed) secp256k1 key. One implementation, used identically by payer/recipient/backend. Coordinate the release with the multisig Layer-1 work (same repo/branch).

**FAIRWallet (upstream, subtree source):** Pockets (§4.6).

**Peable backend:** user-scoped social-receive address reservation (resolve `@user` → `xpub_social` → next unused address), reusing `reserveAddress`/`derivation`/PaymentIntent. New: `oxyUserId → identity pubkey` resolution (via Oxy DID) — no stored private material.

## 6. Data flow (interfaces)

- **Wallet init:** `deriveScopedSeed("peable/faircoin/v1")` → `KeyManager.fromSeed(seed, net, account)` per pocket.
- **Send to @user:** `searchProfiles` → `POST /v1/social/:username/next_address` (backend) → `{ address, index }` → `sendTransaction(address, amount, feeRate)`.
- **Receive:** scan `xprv_social` children `0..gap` + private spending tree; `addr(0)` shown as default.
- **Backend social resolve:** `username → getProfileByUsername → userId → resolveDid → IK_pub → xpub_social → reserveNextIndex(scan) → addr`.

## 7. Security model & threat considerations

- **Trust boundary:** private keys on-device only; server sees only public identity keys / public xpubs / broadcast txids. Non-custody enforced (backend rejects any private key, same firewall as `Merchant`/`derivation.ts`).
- **Spend authorisation:** device unlock + app PIN/biometric before signing.
- **Backup/recovery:** the Oxy recovery phrase (Commons) is the sole backup — losing device + phrase = unrecoverable (self-custody price).
- **Documented residual risks (no "100% unhackable"):** (a) unlocked device + app access → spend; (b) lost device + lost recovery phrase → unrecoverable; (c) identity-key reuse in the social-receive branch (§4.3) — mitigated by domain-separated derivation and pending `security-reviewer` sign-off; (d) social-receive privacy = fresh addresses per payment, but `addr(0)` (favourite) is reused by design.
- **Mandatory gate:** `security-reviewer` audit of the derivation + social scheme before mainnet.

## 8. Testing strategy

- **Crypto (unit):** derivation determinism (same identity → same seed/addresses across runs/devices); payer-derived `addr(i)` == recipient-derived `addr(i)`; recipient can spend funds sent to a payer-computed address (testnet); wrong identity cannot derive/spend.
- **Key separation:** spending-tree addresses are NOT publicly derivable from identity pubkey; social-receive addresses ARE.
- **Onboarding (native, foregrounded device/emulator):** signed-out → sign-in; keyless → identity creation; identity present → wallet appears with no seed screen.
- **Social send (testnet end-to-end):** search → pay @user → recipient (fresh install, same identity) sees + spends funds; pay a keyless user → "invite" path.
- **Pockets (FAIRWallet, upstream):** per-account isolation, balances, move-between self-transfer; regression of existing single-account behaviour.
- Verify runtime UI on a real **foregrounded** device (Bloom/Reanimated/expo-router rules).

## 9. Platform constraint (native-only wallet)

The identity key is unavailable on web (`getPrivateKey`/`getSharedPrivateKey` → `null`). Therefore the **wallet (derive/receive/send/pockets) is native-only**. Web Peable is limited to management/marketing/hosted-checkout surfaces (future), not a spending wallet. This is acceptable: the primary product is the mobile app.

## 10. Implementation phases (sequencing)

1. **WS-P Pockets** in FAIRWallet upstream → push → `git subtree pull` into Peable. (Independent; can start first.)
2. **WS-F Foundation:** `@oxy.so/core` `deriveScopedSeed` (+ publish) → Peable wallet-init from identity → Oxy-first onboarding + keyless handling. Remove multi-wallet UI.
3. **WS-S Social:** `@fairco.in/core` social-receive helper (+ publish; `@oxy.so/core` unchanged — recipient uses its existing raw-identity-key access) → backend user-address reservation + transaction-attribution/enrichment service (§4.8) → Peable social send/receive UI (user search, default+fresh addresses) + rich transaction history (merchant name+logo / user avatar+name) → demote raw-address send.
4. **Security review** (`security-reviewer`) of the full derivation + social scheme → address findings → only then a mainnet-capable build.

Each phase gets its own implementation plan (`writing-plans`).

## 11. Open questions / future

- Stealth/BIP47-style full-privacy receive (beyond fresh addresses) — future.
- Gateway broadcast fallback when SPV peer count is 0 (reliability) — likely needed but out of this design.
- Multi-device conflict handling (same identity, two devices, concurrent pocket edits) — reconcile via on-chain state; UI later.
- Internal rebrand of FAIRWallet strings ("FAIRWallet" header → "Peable") in Peable — tracked separately in the roadmap.

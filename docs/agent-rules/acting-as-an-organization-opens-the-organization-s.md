<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Acting as an organization opens the ORGANIZATION's wallet

The wallet belongs to the account the session acts as (oxy ADR 0001):
`useAuth().user`, which is the organization when a person acts as one, and
whose bearer the gateway answers for (`/v1/social/me/*` is then the
organization's — no route of its own). `src/wallet/organization-wallet.ts`
decides it: an organization's wallet is `oxy-org-<id>`, its seed is
`deriveScopedSeed(PEABLE_SEED_INFO, { accountId })` and its social-receive coins
are signed with `signSocialReceive(…, { accountId })` (oxy ADR 0061 D6) — never
the person's key, which would hand the organization's payers addresses that
leave with that person. `oxy.accounts.identityKey.get` says who may hold it
(403 → only owners and admins) and which key it publishes (`null` → "Set up the
organization's Peable wallet" in Commons); a phone without the key is sent to
Commons to add it; a phone holding a REPLACED key opens it with social receive
off (ADR 0002). `useWalletFollowsActingAccount` closes the wallet on every
account switch so the previous account's wallet is never shown, or spent, under
the new one. Project, bot, channel and community accounts open no wallet.

**Each person's wallet is their account's, and its key is vouched for (ADR
0002, rounds 5 to 7).** The person's wallet is `oxy-user-<accountId>` — never
one shared id — and every per-wallet store follows it; the pre-round-5
`oxy-identity` namespace moves to the account that proves it, keeping only
what that account's keys derive (`wallet/identity-namespace.ts`,
`Database.keepOnlyOwnerData`; each tree derived well past every stored row,
coin and previous-key cursor, and multisig rows naming the owner's keys kept),
and is merged — never copied over — into a wallet already in use; a check is
recorded only when definite (core's `null` for a key this device holds is not
an answer), and asked again when the key history or ring changes (Settings →
"Recover an earlier wallet"). The check never blocks the account's own wallet
from opening, and runs in the init queue, a real mutex (`wallet/init-queue.ts`:
not re-entrant — a queued task brings a wallet up with `initializeHeld`, never
`initialize`).
Which key a wallet opens with is `wallet/identity-key.ts`'s decision from what
the ACCOUNT vouches for, and every seed derivation and social-receive
signature names that key (`publicKey` selector);
`KeyManager.getSharedPublicKey` (the iOS keychain group every Oxy app can
write) is a hint only. **Only a `null` key read means "not held here"**: a
throw (`@oxy.so/core`'s `IdentityUnavailableError` from a selected derivation
or signature while the keychain is locked or Commons busy, or any other) is
"try again later" (`wallet/identity-unavailable.ts`) — the decision stops as
`unavailable` rather than opening another key as `replaced`, a previous key is
`unavailable` rather than stranded, and the entry screen shows the
`key-unavailable` block, never sign-in, "set up your Oxy ID" or
`not-on-device`. Nothing is retired, unbound or hidden, and social receive
stays as the gateway's verdict left it. **Every `addresses` row records the key it derives from
(`identity_public_key`), and only the open key's rows that the open tree
derives are ever offered** (`wallet/receive-address.ts`): after a rotation the
same file still holds the replaced key's rows. Unbound rows are judged by a
probe of the open key's tree that reaches the highest unbound index, never by
the open tree's own window (a used row behind a long unused gap was never
bound). Nothing receivable — address,
QR, `@username`, the Settings header — is shown until the ONE receive gate
opens (`wallet/receive-gate.ts`, `useReceiveGate`): the gateway's fresh
`#key-1` equals the open key, and a wallet adopted from the shared keychain
group was confirmed by the person. A new surface that shows an address goes
through that gate. The keychain move takes nothing from the shared group
without this app's own sandbox evidence of an earlier install
(`storage/install-evidence.ts`), counted only while its nonce is in the
wallet's own group "this device only" (a backup restored onto another phone
carries the file, never the nonce), never a cached seed or the PIN record, and
reads it only through the non-prompting reader (`@oxy.so/core/session`'s
`readSharedWithoutInteraction`). Wallets in the own group when the move
already happened are listed as adopted once (`peable_keychain_split_v2`):
1.2–1.4 builds adopted from the shared group without recording it.

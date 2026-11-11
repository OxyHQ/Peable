<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# The reservation is the highest-risk thing in this repo

`db/social/receiveCursor.ts` decides which address a payer sends money to — for
EVERY FairCoin payment: an `@username` payment, a merchant's (its owner's
wallet) and a seller's (ADR 0021 D5). There is no other counter: the
per-merchant and per-seller xpub counters are gone with the xpubs. It is ONE
statement, `INSERT … ON CONFLICT DO UPDATE … RETURNING next_derivation_index -
1`, which folds the lazy create into the claim, takes the row lock, and records
the identity key the address derives from. Never split it into a read followed
by a write: two callers reading the same value derive the same address, and two
payments land where the gateway can tell only one of them apart. The `- 1` is
load-bearing: the column holds the NEXT index, so the statement returns exactly
the index that call owns; dropping it hands out an index one past the one
recorded. One account has ONE cursor per network, so merchant, seller and social
payments to it can never collide.

**Every address is bound to its key (ADR 0002, amended).** The PUBLIC key an
address derives from is stored beside it (`payment_intent_outputs.
identity_public_key`, `payment_intents.faircoin_identity_public_key`,
`social_send_attributions.identity_public_key`), and
`services/faircoin/keyBinding.ts` is the one place that compares it with the
recipient's current `#key-1`: a payment nobody reported a txid for under a
replaced key (or on a network the deployment closed) is retired — only once the
Explorer shows its addresses unused, because "no txid" is not "not paid".

**Every address is fresh, and the bound is a rate (ADR 0021 D9, amended
2026-11-06).** A payment's address is reserved in the payment's OWN
transaction by `services/faircoin/addressPool.ts`'s `reservePlannedAddresses`,
an `@username` one with its attribution in ONE transaction by
`reserveSocialSendAddress` (`services/socialReceive.ts`); both go through
`reserveFreshAddress` — the one-statement cursor, skipping an index whose
address history already holds. Addresses are never recycled. A recipient gets
a new payment address only while fewer than 500 of its payment addresses of the
last 24 h are unpaid, and a new `@username` address only while fewer than 500
were handed out fresh in the last 24 h — each counted under a per-recipient
advisory lock (`pg_advisory_xact_lock`, `db/payments/faircoinAddressPool.ts`);
past it, 503 `faircoin_capacity_reached`. Per-payer limits sit in front
(`lib/faircoinPayerLimit.ts` on anonymous FairCoin confirms and invoice pays,
the sender and pair limiters on `@username`). Never hand out an address
outside those functions, and never record it outside the reservation's
transaction: the cursor's row lock is what makes the index the wallet's sync
cursor.

The counters are `integer` on purpose (see `CONVENTIONS.md` §Counters) — a
`bigint` column comes back from postgres.js as a STRING, and `"0" + 1` is `"01"`.
Any change there must keep the two-consecutive-reservation test, because a single
reservation cannot tell a number from a string that prints the same.

There is no ceiling on the tree. The wallet watches EXACTLY the addresses
handed out, synced from `GET /v1/social/me/receive_addresses` (the union of
`payment_intent_outputs` and `social_send_attributions`, every key the account
ever had, paged by `derivation_index`) — the recent and funded ones in its
Bloom filter, the rest read on the Explorer on a doubling schedule
(`packages/frontend/src/wallet/social-receive-watch.ts`). Never reintroduce a
contiguous window or an index limit.

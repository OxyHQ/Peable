<!-- Moved verbatim from AGENTS.md; the rules below are unchanged and binding. -->

# Chain access: Explorer HTTP, not RPC

The backend talks to the **FairCoin Explorer HTTP API** (`services/explorer.ts`,
`EXPLORER_BASE_URL` from `@fairco.in/core`). There is **no** FairCoin RPC client
and no RPC node dependency anywhere in this repo. `@fairco.in/core` is the only
`@fairco.in/*` package any workspace depends on.

`services/settlementWatcher.ts` polls the Explorer for in-flight intents.
Only FairCoin `processing` intents carrying a payer-reported txid are watchable
(it verifies EVERY output of `faircoinOutputsOf`, ADR 0021 D6)
(`submit_tx` moves `requires_action → processing` with the txid in one write);
`requires_action` and the terminal statuses are never polled. Every Explorer
read is bounded (`AbortSignal.timeout`, one `explorerFetch`); a read that times
out is the Explorer not answering — a throw, `unknown` or `null` list — never a
missing transaction or an unused address. While a paid
transaction confirms it writes the live `confirmations` count (same status, no
event); at the merchant's threshold it is `succeeded`, and a transaction that pays LESS
is `canceled` with `cancellation_reason: 'underpaid'`. Its timer is
`.unref()`-ed so it cannot hold a test run or the event loop open.

**The gateway is not a chain proxy for wallets.** It reads the chain to settle
intents and nothing else. `/api/address/:a` DOES answer (balance, txCount,
utxos, plus `/txs` for paginated history); `addressindex` is on, whatever an
old note says. The surface that needs address
balances is the wallet, and `frontend/src/services/explorer-address.ts` reads
them directly: the Explorer echoes the request Origin in
`access-control-allow-origin`, so a browser reaches it with no proxy.

Take `balanceSat` and not the cumulative `totalReceivedSat` / `totalSentSat`
beside it. Those grow without bound and one live address already reports
6_969_626_939_280_430 — within 1.3x of `Number.MAX_SAFE_INTEGER`, so
`JSON.parse` rounds them before any code can widen them to a bigint. A balance
is bounded by the money supply and has ~14x of headroom.

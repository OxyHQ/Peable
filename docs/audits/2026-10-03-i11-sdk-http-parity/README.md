# SDK0.2.1: optional deadlines and operation-key preservation

Sourcecd9174f, main77e7409. This patch permits the Mercaria consumer to retain
its20s per-attempt HTTP deadline while replacing local token/HTTP plumbing.
`requestTimeoutMs` is optional; absence retains SDK0.2.0 behavior. Both mint and
gateway fetch/body use the configured signal. Interrupted mint bodies become
PeableApiError with known status and invalid_response. No automatic timeout
retry; only the pre-existing single401 refresh remains.

Reject/refund.create/transfer.create accept optional idempotencyKey passthrough.
ExternalRef and financial semantics remain unchanged; shared-types stays0.3.0,
no backend route or deployment change.

Real HTTP RED:5fail (4ignored deadlines +3dropped keys inone test). Initial
green attempt127/1 exposed a missed reject passthrough and is retained. Final
130/130 PASS over14files includes header/body timeouts at both boundaries, known
status, no repeated POST, explicit same-key recovery withone remote effect and
key/body preservation. Strict package TypeScript (including tests) passes; an
initial lowercaseUSD fixture type error was corrected to canonicalUSD.

Fresh build+pack same command, candidate unpublished. Isolated tarball consumer
resolves declared shared-types^0.3.0 from registry (no overrides); Node CJS/ESM
load, strict NodeNext public options compile with skipLibCheck. It makes no auth
or payment requests. Archive and fixture evidence hashes are retained in proof.
Publication requires a fresh same-command build+pack+publish, not this archive.
No new payment rail/cohort activation or Stripe sandbox run occurred.

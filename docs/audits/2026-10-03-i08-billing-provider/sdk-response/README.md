# SDK response integrity discovered by real test Checkout

Source `251b760` rejects empty/malformed JSON on a successful response except
explicit HTTP 204. Error responses retain their existing status mapping. It does
not retry POSTs automatically. Inventory found no SDK resource or corresponding
route that intentionally returns an empty HTTP 200; 204 remains supported.

Real loopback HTTP tests: **116 pass / 4 fail before**, **120 pass / 0 fail after**.
The four RED cases are empty and malformed JSON on 200/201. Controls cover valid
JSON, 204 and a non-JSON 503. SDK CJS/ESM/types builds pass. The exact asynchronous
Express response-destruction reproduction returns `undefined` before the fix and
throws afterward, with one request and the same intent key. No provider call is
needed to reproduce this SDK defect.

Real Stripe test runs a1/a2 created Checkout successfully but stopped on the
harness assertion expecting response loss to reject. a2 diagnostic evidence shows
`initialCheckoutCallResolved=true` and `responseWasDestroyed=true`; adapter
normalization did not fail. These are **not Stripe/parser failures**, and neither
run proves completed Checkout, renewal or full parity. Oxy auth in this harness
is explicitly synthetic; Stripe, HTTP, the domain and PostgreSQL are real.

Cleanup a1 initially missed the accepted Checkout ID and could not deactivate its
new first/default Portal configuration. Under root-reviewed recovery, one replay
of the exact original POST/key/body returned the original Checkout; it was expired
and read back. The owned default Portal remains active with payment-method update,
subscription update and subscription cancellation all disabled. It is an explicit
residual, not a claim that the provider account was restored to an empty state.

a2 records the accepted Checkout ID before adapter parsing and lists only the run's
own customer sessions before deleting that customer. Checkout expired, customer
deleted, product/price inactive, own database dropped and retained Portal with zero
mutating features all passed readback. It reused the exact retained Portal without
mutating it or creating another default. The PostgreSQL server remains available;
only the harness-owned databases were dropped. Private manifests contain IDs;
public evidence includes sanitized observations and hashes, never hosted URLs,
credentials or raw provider payloads.

[CI 37093944465](https://github.com/OxyHQ/Peable/actions/runs/37093944465) on
`7a211410` passed **1459 tests / 0 failures** and image migration **21**. That CI
precedes this SDK fix; the final release must validate the composed source.

Pending: repeat Checkout with the corrected SDK, separate Test Clock scenarios,
SDK publication, Mercaria adapter/cohort adoption and coordinated activation. The
commercial Mercaria catalogue inventory is empty; synthetic test cohorts are not
commercial adoption or historical records migrated.

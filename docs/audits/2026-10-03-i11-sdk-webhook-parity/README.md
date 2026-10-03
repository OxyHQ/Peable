# Complete webhook allowlist, SDK 0.2.2 candidate

Source a1b0983 fixes a stale SDK-only five-event allowlist. Shared-types0.3.0
already declares ten types; backend services/intentTransition.ts emits payment
status events, dispute payloads and connected-account updates. No financial
contract or backend emitter changes. The new exhaustive Record<WebhookEventType,true>
makes a future union extension require a verifier update at compilation; own-key
lookup rejects prototype names. There is no invented transfer event family.

The existing WebhooksResource is exported from the server root for credential-free
verification. No client, fake credential, token mint, optional peer or new crypto
implementation is needed. Existing shared-types verifyWebhook owns signatures and
tolerance. This verifies signature/envelope/type; it is not a full resource schema
validator or proof of a financial effect.

Package test RED139PASS/5FAIL: exactly refunded, partially_refunded, disputed,
dispute_closed and connected_account.updated. GREEN144/0 over14files includes
all ten signed full typed payloads, wrong secret, past/future301s and unknown
names including __proto__/toString. Existing malformed/tampered/stale tests remain.
Initial TypeScript failure was test expectation union correlation; comparison of
serialized returned object preserves complete payload equality without a cast.
Final strict package TypeScript passes.

Fresh same-command clean/build/pack yields an unpublished0.2.2 candidate. Isolated
CJS/ESM verify all five formerly rejected types using the standalone export;
strict NodeNext consumer compiles (skipLibCheck explicit). Shared-types^0.3.0
resolves from registry without overrides. No auth/payment/provider network; only
registry dependency installation. Mercaria current/previous rotation and ingress
normalization remain a separate consumer acceptance step. Publication will require
review, merged main, CI and a fresh build/pack/publish; this archive is not released.

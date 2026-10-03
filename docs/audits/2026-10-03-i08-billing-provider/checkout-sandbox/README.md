# Real test-mode Checkout: a5 passed

The reviewed script at `acece5e` (SHA in proof.json), with SDK fix `251b760`,
completed all six observation stages. The same existing test key/account was
verified before mutations; no key or hosted URL is present in this evidence.

The built Peable SDK used real loopback HTTP, domain repositories and PostgreSQL.
Oxy mint/auth was an explicit synthetic boundary. Stripe test-mode calls and the
isolated Chromium Checkout form were real. This is not deployed Oxy authentication,
production commerce, Test Clock renewal or Mercaria adoption.

- A customer is reused for the same store despite a new intent/name.
- Checkout commits before the harness drops its HTTP response. The corrected SDK
  rejects the incomplete response; retry with the SAME key recovers that operation.
- Checkout and Portal are created. Portal uses the retained owned default with
  its three mutating features disabled, without changing account settings.
- The browser fills synthetic test details and clicks one visible enabled submit
  normally. Stripe reports Checkout complete and a subscription reference.
- SDK retrieval resolves the complete Checkout against its durable operation and
  customer/price bindings; store, plan, customer, price and test mode all match.
- The SDK cancellation request sets `cancel_at_period_end=true`.

A3/a4 are retained as failed browser rehearsals. A3 did not identify its browser
step. A4 filled the form but timed out at the English-name submit selector; the
observed normal submit control motivated a language-independent selector. No
force click, CAPTCHA solver or anti-bot bypass was used. A5's final document DNS
error is the deliberately nonexistent return destination after Checkout completed;
the authoritative provider completion/readback passed.

A5 cleanup has **7/7** successful readbacks: complete Checkout, own customer
removed, subscription canceled by that explicitly approved fixture teardown,
product/price inactive, own database dropped, retained Portal active/default with
zero mutating features. Customer teardown is not a new immediate-cancel API.
The exact five owned a1-a5 database names are absent from pg_database; the local
agent-owned PostgreSQL server remains running. The retained default is a documented
residual, not an assertion that the Stripe account is empty/restored.

Pending: separate Test Clock lifecycle/payment-failure/refund observations,
Mercaria transitional webhook projection and cohort adapter, SDK publication and
coordinated adoption. No historical commercial records were migrated by this test.

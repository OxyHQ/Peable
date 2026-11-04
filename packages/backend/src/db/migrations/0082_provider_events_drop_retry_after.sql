-- oxy:deploy-phase=post
-- Retiring the Stripe-Billing proxy, part 3 of 3 (hand-written): the recurring
-- drain's deferral column. Only the proxy's observation relay and ADR 0013's
-- renewal hold ever set it; the drain no longer reads it. `provider_events`
-- is hot, so this sits alone: dropping a column is a catalog change (no
-- rewrite), taken under the migrator's short lock_timeout.
ALTER TABLE "provider_events" DROP COLUMN "retry_after";

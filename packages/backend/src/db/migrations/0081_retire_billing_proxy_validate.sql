-- oxy:deploy-phase=post
-- Retiring the Stripe-Billing proxy, part 2 of 3 (hand-written): VALIDATE the
-- two CHECKs 0080 re-added NOT VALID. VALIDATE takes SHARE UPDATE EXCLUSIVE,
-- so reads and writes continue.
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";

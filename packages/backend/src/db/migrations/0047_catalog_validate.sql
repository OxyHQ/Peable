-- oxy:deploy-phase=post
-- ADR 0018: validate the two event-catalog CHECKs 0046 re-added NOT VALID.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes continue while it
-- scans. Hand-written (a custom migration): drizzle-kit has no NOT VALID.
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";

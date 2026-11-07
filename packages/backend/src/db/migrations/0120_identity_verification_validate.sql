-- oxy:deploy-phase=post
-- Identity verification (ADR 0023), part 2 of 2: validates the CHECKs 0119
-- added NOT VALID. VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes
-- continue while it scans.
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";

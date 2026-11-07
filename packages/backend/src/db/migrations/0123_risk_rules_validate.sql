-- oxy:deploy-phase=post
-- Risk rules (ADR 0022), part 3 of 3: validates the CHECKs 0121 added NOT
-- VALID. VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes continue
-- while it scans.
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_intent_event_has_intent_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";

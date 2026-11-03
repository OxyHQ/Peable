-- oxy:deploy-phase=post
-- Peable Tax business compliance (ADR 0020), part 2 of 2 (hand-written):
-- VALIDATE the three CHECKs the previous migration re-added NOT VALID.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes continue.
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "files" VALIDATE CONSTRAINT "files_purpose_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";

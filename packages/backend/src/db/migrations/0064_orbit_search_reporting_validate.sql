-- oxy:deploy-phase=post
-- Orbit Phase 8, the validations: every CHECK 0062 re-added `NOT VALID`, validated
-- once the outgoing image (which never writes a report file or event) is gone.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: reads and writes continue while it scans.
ALTER TABLE "charges" VALIDATE CONSTRAINT "charges_billing_details_object_check";--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "files" VALIDATE CONSTRAINT "files_purpose_check";--> statement-breakpoint
ALTER TABLE "files" VALIDATE CONSTRAINT "files_type_check";--> statement-breakpoint
ALTER TABLE "files" VALIDATE CONSTRAINT "files_size_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";

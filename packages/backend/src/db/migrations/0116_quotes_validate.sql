-- oxy:deploy-phase=post
-- Quotes (ADR 0018 §5), part 2 of 2: validates the CHECKs 0115 added NOT
-- VALID. VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes continue
-- while it scans.
ALTER TABLE "billing_settings" VALIDATE CONSTRAINT "billing_settings_next_quote_number_check";--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "invoices" VALIDATE CONSTRAINT "invoices_billing_reason_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";

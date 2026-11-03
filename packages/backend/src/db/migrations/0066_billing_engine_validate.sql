-- oxy:deploy-phase=post
-- ADR 0018: validate the constraints the billing engine's pre migration (0065)
-- added NOT VALID to existing tables. VALIDATE takes SHARE UPDATE EXCLUSIVE, so
-- reads and writes continue while it scans. Hand-written (a custom migration):
-- drizzle-kit has no NOT VALID.
ALTER TABLE "customer_emails" VALIDATE CONSTRAINT "customer_emails_invoice_fkey";--> statement-breakpoint
ALTER TABLE "customer_emails" VALIDATE CONSTRAINT "customer_emails_kind_check";--> statement-breakpoint
ALTER TABLE "customer_emails" VALIDATE CONSTRAINT "customer_emails_subject_check";--> statement-breakpoint
ALTER TABLE "customers" VALIDATE CONSTRAINT "customers_test_clock_fkey";--> statement-breakpoint
ALTER TABLE "customers" VALIDATE CONSTRAINT "customers_balance_check";--> statement-breakpoint
ALTER TABLE "prices" VALIDATE CONSTRAINT "prices_meter_fkey";--> statement-breakpoint
ALTER TABLE "prices" VALIDATE CONSTRAINT "prices_recurring_check";--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";

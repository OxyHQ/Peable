-- oxy:deploy-phase=post
-- ADR 0015, the contract half. The requirement COUNTS are replaced by the
-- identifier lists added pre-deploy; the outgoing image still reads them, so
-- they go only once it is gone. Hand edit: the VALIDATE of every constraint this
-- set added `NOT VALID` is appended (SHARE UPDATE EXCLUSIVE: reads and writes
-- continue while it scans) — one post migration, last in the journal.
ALTER TABLE "connected_accounts" DROP CONSTRAINT "connected_accounts_requirements_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "requirements_currently_due";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "requirements_eventually_due";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "requirements_past_due";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "requirements_pending_verification";--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "refunds" VALIDATE CONSTRAINT "refunds_reason_check";--> statement-breakpoint
ALTER TABLE "refunds" VALIDATE CONSTRAINT "refunds_status_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" VALIDATE CONSTRAINT "connected_accounts_role_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" VALIDATE CONSTRAINT "connected_accounts_role_external_ref_agrees_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" VALIDATE CONSTRAINT "connected_accounts_merchant_role_is_card_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_transfer_destination_merchant_fkey";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_on_behalf_of_merchant_fkey";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_destination_fields_check";

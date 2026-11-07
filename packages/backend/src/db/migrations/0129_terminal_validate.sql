-- oxy:deploy-phase=post
-- Terminal (ADR 0024), part 4 of 4: validates what 0126, 0127 and 0128
-- added NOT VALID. VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes
-- continue while it scans.
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_payment_method_types_check";--> statement-breakpoint
ALTER TABLE "terminal_readers" VALIDATE CONSTRAINT "terminal_readers_action_payment_intent_fkey";

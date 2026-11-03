-- oxy:deploy-phase=post
-- ADR 0019: validate every constraint 0042 added NOT VALID, now that 0043 has
-- converted the rows. VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes
-- continue while it scans.
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_customer_merchant_fkey";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_payment_method_merchant_fkey";--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_intent_event_has_intent_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_cancellation_reason_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_canceled_agrees_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_capture_method_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_setup_future_usage_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_card_only_fields_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_amount_received_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_amount_received_agrees_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_last_payment_error_object_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_shipping_object_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_processing_requires_txid_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_status_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_card_statuses_are_card_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";

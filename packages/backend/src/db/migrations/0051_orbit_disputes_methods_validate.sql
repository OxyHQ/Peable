-- oxy:deploy-phase=post
-- Orbit Phase 2b (hand-written): every card payment made before payment method
-- breadth offered cards only, so it is backfilled to `{card}` (DML on the hot
-- table, with no exclusive DDL beside it); then VALIDATE every constraint the
-- two pre migrations added NOT VALID. VALIDATE takes SHARE UPDATE EXCLUSIVE, so
-- reads and writes continue while it scans.
UPDATE "payment_intents" SET "payment_method_types" = ARRAY['card']::text[]
WHERE "rail" = 'card' AND "payment_method_types" IS NULL;
--> statement-breakpoint
ALTER TABLE "charges" VALIDATE CONSTRAINT "charges_currency_check";
--> statement-breakpoint
ALTER TABLE "coupons" VALIDATE CONSTRAINT "coupons_discount_check";
--> statement-breakpoint
ALTER TABLE "disputes" VALIDATE CONSTRAINT "disputes_metadata_object_check";
--> statement-breakpoint
ALTER TABLE "disputes" VALIDATE CONSTRAINT "disputes_currency_check";
--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";
--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_intent_event_has_intent_check";
--> statement-breakpoint
ALTER TABLE "oxy_file_reconciliation_runs" VALIDATE CONSTRAINT "oxy_file_reconciliation_runs_entity_type_check";
--> statement-breakpoint
ALTER TABLE "oxy_file_reference_syncs" VALIDATE CONSTRAINT "oxy_file_reference_syncs_entity_type_check";
--> statement-breakpoint
ALTER TABLE "payment_links" VALIDATE CONSTRAINT "payment_links_currency_check";
--> statement-breakpoint
ALTER TABLE "prices" VALIDATE CONSTRAINT "prices_currency_check";
--> statement-breakpoint
ALTER TABLE "promotion_codes" VALIDATE CONSTRAINT "promotion_codes_minimum_amount_check";
--> statement-breakpoint
ALTER TABLE "refunds" VALIDATE CONSTRAINT "refunds_currency_check";
--> statement-breakpoint
ALTER TABLE "transfer_reversals" VALIDATE CONSTRAINT "transfer_reversals_currency_check";
--> statement-breakpoint
ALTER TABLE "transfers" VALIDATE CONSTRAINT "transfers_currency_check";
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";
--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_currency_check";
--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_currency_check";
--> statement-breakpoint
ALTER TABLE "merchants" VALIDATE CONSTRAINT "merchants_business_logo_file_fkey";
--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_payment_method_configuration_merchant_fkey";
--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_payment_method_types_rail_check";
--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_payment_method_types_check";
--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_payment_method_configuration_card_check";

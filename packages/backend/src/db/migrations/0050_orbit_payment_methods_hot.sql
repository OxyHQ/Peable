-- oxy:deploy-phase=pre
-- Orbit Phase 2b — the hot-table half: `payment_intents` gains its card-rail
-- `payment_method_types` and `payment_method_configuration_id`, `merchants`
-- its `business_logo_file_id`, and both hot tables' currency CHECK widens.
-- Hand edits:
--   * the two `currency_check` statements moved here from the previous migration;
--   * every constraint is `NOT VALID`, validated in the post migration.
-- No DML and no index build here (hot-table rule); the backfill is post.
ALTER TABLE "checkout_sessions" DROP CONSTRAINT "checkout_sessions_currency_check";
--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_currency_check";
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "business_logo_file_id" text;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "payment_method_types" text[];
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "payment_method_configuration_id" text;
--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_business_logo_file_fkey" FOREIGN KEY ("business_logo_file_id","id") REFERENCES "public"."files"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_method_configuration_merchant_fkey" FOREIGN KEY ("payment_method_configuration_id","merchant_id") REFERENCES "public"."payment_method_configurations"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_method_types_rail_check" CHECK ("payment_intents"."rail" = 'card' or "payment_intents"."payment_method_types" is null) NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_method_types_check" CHECK (payment_method_types is null or (cardinality(payment_method_types) >= 1 and payment_method_types <@ ARRAY['card', 'sepa_debit', 'ideal', 'bancontact', 'eps']::text[])) NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_method_configuration_card_check" CHECK ("payment_intents"."rail" = 'card' or "payment_intents"."payment_method_configuration_id" is null) NOT VALID;

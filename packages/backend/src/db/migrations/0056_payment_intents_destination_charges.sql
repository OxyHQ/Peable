-- oxy:deploy-phase=pre
-- ADR 0015 §2 — destination-charge fields on `payment_intents`, alone (hot
-- table). Hand edits: both foreign keys and the CHECK are `NOT VALID`
-- (validated post); the nullable columns are catalog-only.
ALTER TABLE "payment_intents" ADD COLUMN "transfer_destination_id" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "transfer_amount" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "on_behalf_of_id" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "application_fee_amount" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_transfer_destination_merchant_fkey" FOREIGN KEY ("transfer_destination_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_on_behalf_of_merchant_fkey" FOREIGN KEY ("on_behalf_of_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_destination_fields_check" CHECK ((rail = 'card' or (transfer_destination_id is null and on_behalf_of_id is null and application_fee_amount is null and transfer_amount is null))
          and (application_fee_amount is null or transfer_destination_id is not null)
          and (transfer_amount is null or transfer_destination_id is not null)
          and (application_fee_amount is null or transfer_amount is null)
          and (application_fee_amount is null or (application_fee_amount ~ '^(0|[1-9][0-9]*)$' and application_fee_amount::numeric <= amount::numeric))
          and (transfer_amount is null or (transfer_amount ~ '^(0|[1-9][0-9]*)$' and transfer_amount::numeric <= amount::numeric))) NOT VALID;

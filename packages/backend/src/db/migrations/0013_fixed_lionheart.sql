-- oxy:deploy-phase=pre
-- `transfer_reversals` — a durable identity per reversal operation.
--
-- `reverseTransfer` derived its provider idempotency key from
-- `trr:<transfer>:<amount>`, so two DISTINCT reversals of one transfer for the
-- same amount — two 500-cent line items refunded separately, which is ordinary
-- — presented one key. The provider answered the first reversal's object to the
-- second request, the cumulative total stayed at 500, and the seller kept money
-- that had been taken back. An amount is not an identity.
--
-- `pre`, and it adds a table nothing else references. The old image neither
-- reads nor writes it, so it can serve through the whole rollout unchanged.
CREATE TABLE "transfer_reversals" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"transfer_id" text NOT NULL,
	"external_ref" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text,
	"failure_message" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "transfer_reversals_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "transfer_reversals_merchant_external_ref_key" UNIQUE("merchant_id","external_ref"),
	CONSTRAINT "transfer_reversals_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "transfer_reversals_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "transfer_reversals_status_check" CHECK (status in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "transfer_reversals_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD')),
	CONSTRAINT "transfer_reversals_external_ref_check" CHECK (length("transfer_reversals"."external_ref") > 0),
	CONSTRAINT "transfer_reversals_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "transfer_reversals_amount_positive_check" CHECK ("transfer_reversals"."amount"::numeric > 0),
	CONSTRAINT "transfer_reversals_succeeded_has_provider_object_check" CHECK ("transfer_reversals"."status" <> 'succeeded' or "transfer_reversals"."provider_object_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "transfer_reversals" ADD CONSTRAINT "transfer_reversals_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_reversals" ADD CONSTRAINT "transfer_reversals_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "public"."transfers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfer_reversals_transfer_idx" ON "transfer_reversals" USING btree ("transfer_id");
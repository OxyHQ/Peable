-- oxy:deploy-phase=pre
-- Peable Tax: card renewals are repriced, refunds are reversed (ADR 0013).
--
-- `pre`, and safe under the image that predates it:
--
--  * `billing_renewal_taxes` is new; the old image never reads or writes it.
--  * The three `tax_transactions` columns are nullable and the old image never
--    writes them, so the reversal-shape CHECK holds for every row it produces.
--  * The calculation's uniqueness moves from a table constraint to a partial
--    unique index over originals, in this same transaction. For every row the
--    old image can write (an original) it checks exactly what the constraint
--    did, and its `ON CONFLICT DO NOTHING` names no target, so it still
--    converges on a redelivery.
CREATE TABLE "billing_renewal_taxes" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"provider" text NOT NULL,
	"livemode" boolean NOT NULL,
	"invoice_ref" text NOT NULL,
	"subscription_ref" text NOT NULL,
	"calculation_id" text NOT NULL,
	"tax_rate_ref" text,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_renewal_taxes_invoice_key" UNIQUE("provider","livemode","invoice_ref"),
	CONSTRAINT "billing_renewal_taxes_provider_check" CHECK ("billing_renewal_taxes"."provider" = 'stripe'),
	CONSTRAINT "billing_renewal_taxes_snapshot_check" CHECK (jsonb_typeof("billing_renewal_taxes"."snapshot") = 'object')
);
--> statement-breakpoint
ALTER TABLE "tax_transactions" DROP CONSTRAINT "tax_transactions_calculationId_unique";--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD COLUMN "reversal_of_id" text;--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD COLUMN "reversal" jsonb;--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD COLUMN "provider_payment_ref" text;--> statement-breakpoint
ALTER TABLE "billing_renewal_taxes" ADD CONSTRAINT "billing_renewal_taxes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_renewal_taxes" ADD CONSTRAINT "billing_renewal_taxes_calculation_id_tax_calculations_id_fk" FOREIGN KEY ("calculation_id") REFERENCES "public"."tax_calculations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_reversal_of_id_tax_transactions_id_fk" FOREIGN KEY ("reversal_of_id") REFERENCES "public"."tax_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_transactions_calculation_key" ON "tax_transactions" USING btree ("calculation_id") WHERE "tax_transactions"."reversal_of_id" IS NULL;--> statement-breakpoint
CREATE INDEX "tax_transactions_reversal_of_idx" ON "tax_transactions" USING btree ("reversal_of_id");--> statement-breakpoint
CREATE INDEX "tax_transactions_payment_ref_idx" ON "tax_transactions" USING btree ("provider_payment_ref") WHERE "tax_transactions"."provider_payment_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_reversal_shape_check" CHECK (("tax_transactions"."reversal_of_id" IS NULL) = ("tax_transactions"."reversal" IS NULL));
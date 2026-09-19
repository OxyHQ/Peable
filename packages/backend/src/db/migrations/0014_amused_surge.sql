-- oxy:deploy-phase=pre
-- A refund can now come from the PROVIDER, not only from the merchant.
--
-- `handleRefundEvent` treated a refund with no local row as `unmatched` and
-- retried it forever, with a comment explaining that inventing a merchant
-- `external_ref` for a refund the merchant never made would put an amount in
-- this database that nothing chose. That reasoning was right and the conclusion
-- was not: the payer's money was back, the gateway still called the payment
-- `settled`, and the event sat in the drain. A refund issued from the
-- acquirer's dashboard, or created by the network resolving a dispute, is a
-- fact about money whether or not a merchant asked for it.
--
-- So `external_ref` becomes nullable and `origin` records who created the row.
-- The unique index becomes PARTIAL, which says what is being promised: it
-- governs merchant-initiated refunds and makes no claim about imported ones.
--
-- `pre`, and safe under the old image: it writes `external_ref` on every insert
-- and never writes `origin`, whose default (`merchant`) is exactly what
-- `refunds_origin_ref_agrees_check` requires beside a non-null reference. No
-- backfill is needed for the same reason.
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_merchant_external_ref_key";--> statement-breakpoint
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_external_ref_check";--> statement-breakpoint
ALTER TABLE "refunds" ALTER COLUMN "external_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "origin" text DEFAULT 'merchant' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_merchant_external_ref_key" ON "refunds" USING btree ("merchant_id","external_ref") WHERE "refunds"."external_ref" is not null;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_origin_check" CHECK (origin in ('merchant', 'provider'));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_origin_ref_agrees_check" CHECK (("refunds"."origin" = 'merchant') = ("refunds"."external_ref" is not null));--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_external_ref_check" CHECK ("refunds"."external_ref" is null or length("refunds"."external_ref") > 0);
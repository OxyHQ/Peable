-- oxy:deploy-phase=pre
-- One new table, and the SAME widening of `webhook_deliveries_event_type_check`
-- that `0006_cloudy_pandemic.sql` did one release earlier — two more event types
-- this time, `payment_intent.disputed` and `payment_intent.dispute_closed`.
--
-- `pre` for the two reasons that file already records, and both still hold. The
-- drop-and-re-add reads destructive and is not: the replacement accepts every
-- value the original did plus two, so every existing row passes and the RUNNING
-- image — which writes only the seven types it knows — keeps working unchanged.
-- A rollback to it is safe too, running against a constraint wider than its own.
--
-- And the ORDER matters the other way round, which is what makes `pre`
-- necessary rather than merely allowed: the image that writes a
-- `payment_intent.disputed` delivery cannot roll out before the constraint that
-- admits it, or the first dispute this gateway ever receives fails on a CHECK.
--
-- `disputes` itself is a plain CREATE TABLE — nothing reads or writes it until
-- the image that owns it is live, so it is additive under any ordering.
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'needs_response' NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"reason" text,
	"evidence_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "disputes_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "disputes_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "disputes_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "disputes_status_check" CHECK (status in ('needs_response', 'under_review', 'won', 'lost')),
	CONSTRAINT "disputes_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD')),
	CONSTRAINT "disputes_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "disputes_amount_positive_check" CHECK ("disputes"."amount"::numeric > 0),
	CONSTRAINT "disputes_closed_has_no_deadline_check" CHECK ("disputes"."status" not in ('won', 'lost') or "disputes"."evidence_due_at" is null)
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_type_check";--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "disputes_payment_intent_idx" ON "disputes" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE INDEX "disputes_evidence_due_idx" ON "disputes" USING btree ("evidence_due_at");--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_type_check" CHECK (event_type in ('payment_intent.confirming', 'payment_intent.settled', 'payment_intent.failed', 'payment_intent.rejected', 'payment_intent.expired', 'payment_intent.refunded', 'payment_intent.partially_refunded', 'payment_intent.disputed', 'payment_intent.dispute_closed'));
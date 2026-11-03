-- oxy:deploy-phase=pre
-- Orbit Phase 8 — Search and report runs. New: `report_runs`; `charges.billing_details`;
-- the search walk indexes on the non-hot `charges`, `customers` (lower(email)) and
-- `refunds` (the hot `payment_intents` one is alone in 0063); `files` takes the
-- `finance_report_run` purpose, the `csv` type and the report ceiling; `events` /
-- `webhook_endpoints` take `reporting.report_run.succeeded|failed`.
-- HAND EDIT: every CHECK re-added to an existing table is `NOT VALID` (ACCESS
-- EXCLUSIVE without a scan); 0064 (post) validates them.
CREATE TABLE "report_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"report_type" text NOT NULL,
	"interval_start" timestamp with time zone NOT NULL,
	"interval_end" timestamp with time zone NOT NULL,
	"columns" text[],
	"currency" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"result_file_id" text,
	"result_file_purpose" text DEFAULT 'finance_report_run' NOT NULL,
	"succeeded_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "report_runs_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "report_runs_report_type_check" CHECK (report_type in ('payments.itemized.1', 'balance.summary.1', 'payouts.itemized.1')),
	CONSTRAINT "report_runs_status_check" CHECK (status in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "report_runs_result_file_purpose_check" CHECK ("report_runs"."result_file_purpose" = 'finance_report_run'),
	CONSTRAINT "report_runs_currency_check" CHECK (currency is null or currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "report_runs_interval_check" CHECK ("report_runs"."interval_start" < "report_runs"."interval_end"),
	CONSTRAINT "report_runs_columns_check" CHECK ("report_runs"."columns" is null or cardinality("report_runs"."columns") >= 1),
	CONSTRAINT "report_runs_succeeded_agrees_check" CHECK (("report_runs"."status" = 'succeeded') = ("report_runs"."result_file_id" is not null) and ("report_runs"."status" = 'succeeded') = ("report_runs"."succeeded_at" is not null)),
	CONSTRAINT "report_runs_failed_agrees_check" CHECK (("report_runs"."status" = 'failed') = ("report_runs"."error" is not null)),
	CONSTRAINT "report_runs_lease_agrees_check" CHECK (("report_runs"."lease_token" is null) = ("report_runs"."lease_expires_at" is null) and ("report_runs"."status" = 'pending' or "report_runs"."lease_token" is null)),
	CONSTRAINT "report_runs_attempts_check" CHECK ("report_runs"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_purpose_check";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_type_check";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_size_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "billing_details" jsonb;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_result_file_fkey" FOREIGN KEY ("result_file_id","merchant_id","result_file_purpose") REFERENCES "public"."files"("id","merchant_id","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_runs_merchant_id_id_idx" ON "report_runs" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "report_runs_pending_idx" ON "report_runs" USING btree ("id") WHERE "report_runs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "charges_merchant_id_id_idx" ON "charges" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "customers_merchant_id_lower_email_idx" ON "customers" USING btree ("merchant_id",lower("email"));--> statement-breakpoint
CREATE INDEX "refunds_merchant_id_id_idx" ON "refunds" USING btree ("merchant_id","id");--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_billing_details_object_check" CHECK ("charges"."billing_details" is null or jsonb_typeof("charges"."billing_details") = 'object') NOT VALID;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_purpose_check" CHECK (purpose in ('dispute_evidence', 'business_logo', 'identity_document', 'additional_verification', 'finance_report_run')) NOT VALID;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_type_check" CHECK (type in ('pdf', 'png', 'jpg', 'csv')) NOT VALID;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_size_check" CHECK (size between 1 and 67108864) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed']::text[]) NOT VALID;
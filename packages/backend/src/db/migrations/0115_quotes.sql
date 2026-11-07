-- oxy:deploy-phase=pre
-- Quotes (`qt_…`, ADR 0018 §5), part 1 of 2: the `quotes` and
-- `quote_line_items` tables, the merchant's quote counter on
-- `billing_settings` (`next_quote_number`, claimed by one upsert), the event
-- catalog widened for quote.created / .finalized / .accepted / .canceled, and
-- `quote_accept` as an invoice billing reason. Additive for the image still
-- serving: nothing it reads changes.
-- HAND EDIT: the four CHECKs (re-)added to existing tables (billing_settings,
-- events, invoices, webhook_endpoints) are NOT VALID, so none scans under
-- ACCESS EXCLUSIVE; the next migration (post) validates them under SHARE UPDATE
-- EXCLUSIVE. Every one only widens its set or holds for the column default, so
-- every existing row already satisfies it.
CREATE TABLE "quote_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"position" integer NOT NULL,
	"price_id" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"currency" text NOT NULL,
	"amount_subtotal" text NOT NULL,
	"amount_discount" text DEFAULT '0' NOT NULL,
	"amount_tax" text DEFAULT '0' NOT NULL,
	"amount_total" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "quote_line_items_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "quote_line_items_quote_position_key" UNIQUE("quote_id","position"),
	CONSTRAINT "quote_line_items_quantity_check" CHECK (quantity between 1 and 1000000),
	CONSTRAINT "quote_line_items_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "quote_line_items_amounts_check" CHECK (amount_subtotal ~ '^(0|[1-9][0-9]*)$' and amount_discount ~ '^(0|[1-9][0-9]*)$' and amount_tax ~ '^(0|[1-9][0-9]*)$' and amount_total ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"test_clock_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"number" text,
	"currency" text NOT NULL,
	"collection_method" text NOT NULL,
	"days_until_due" integer,
	"subscription_description" text,
	"trial_period_days" integer,
	"subscription_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discount_coupon_id" text,
	"discount_promotion_code_id" text,
	"automatic_tax" boolean DEFAULT false NOT NULL,
	"automatic_tax_status" text,
	"tax_calculation_id" text,
	"amount_subtotal" text DEFAULT '0' NOT NULL,
	"amount_discount" text DEFAULT '0' NOT NULL,
	"amount_tax" text,
	"amount_total" text DEFAULT '0' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"header" text,
	"description" text,
	"footer" text,
	"invoice_id" text,
	"subscription_id" text,
	"finalized_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "quotes_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "quotes_status_check" CHECK (status in ('draft', 'open', 'accepted', 'canceled')),
	CONSTRAINT "quotes_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "quotes_collection_method_check" CHECK (collection_method in ('charge_automatically', 'send_invoice')),
	CONSTRAINT "quotes_faircoin_sends_check" CHECK (currency <> 'FAIR' or collection_method = 'send_invoice'),
	CONSTRAINT "quotes_amounts_check" CHECK (amount_subtotal ~ '^(0|[1-9][0-9]*)$' and amount_discount ~ '^(0|[1-9][0-9]*)$' and (amount_tax is null or amount_tax ~ '^(0|[1-9][0-9]*)$') and amount_total ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "quotes_finalized_check" CHECK ((number is null) = (finalized_at is null) and (status <> 'open' or number is not null) and (status <> 'accepted' or number is not null)),
	CONSTRAINT "quotes_status_transitions_check" CHECK ((status = 'accepted') = (accepted_at is not null) and (status = 'canceled') = (canceled_at is not null) and (status = 'accepted' or (invoice_id is null and subscription_id is null)) and (status <> 'accepted' or invoice_id is not null)),
	CONSTRAINT "quotes_automatic_tax_check" CHECK ((automatic_tax_status is null or automatic_tax_status in ('complete', 'requires_location_inputs', 'failed')) and (automatic_tax or (automatic_tax_status is null and tax_calculation_id is null)) and (status = 'draft' or status = 'canceled' or not automatic_tax or automatic_tax_status = 'complete') and (status = 'draft' or status = 'canceled' or amount_tax is not null)),
	CONSTRAINT "quotes_days_until_due_check" CHECK (days_until_due is null or (collection_method = 'send_invoice' and days_until_due between 0 and 365)),
	CONSTRAINT "quotes_trial_period_days_check" CHECK (trial_period_days is null or trial_period_days between 1 and 730),
	CONSTRAINT "quotes_text_check" CHECK ((header is null or char_length(header) between 1 and 50) and (footer is null or char_length(footer) between 1 and 500) and (description is null or char_length(description) between 1 and 1500) and (subscription_description is null or char_length(subscription_description) between 1 and 500)),
	CONSTRAINT "quotes_metadata_check" CHECK (jsonb_typeof("quotes"."metadata") = 'object' and jsonb_typeof("quotes"."subscription_metadata") = 'object')
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_billing_reason_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "billing_settings" ADD COLUMN "next_quote_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_line_items" ADD CONSTRAINT "quote_line_items_price_fkey" FOREIGN KEY ("price_id","merchant_id") REFERENCES "public"."prices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_merchant_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_test_clock_fkey" FOREIGN KEY ("test_clock_id","merchant_id") REFERENCES "public"."test_clocks"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_discount_coupon_fkey" FOREIGN KEY ("discount_coupon_id","merchant_id") REFERENCES "public"."coupons"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_discount_promotion_code_fkey" FOREIGN KEY ("discount_promotion_code_id","merchant_id") REFERENCES "public"."promotion_codes"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_invoice_fkey" FOREIGN KEY ("invoice_id","merchant_id") REFERENCES "public"."invoices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_subscription_fkey" FOREIGN KEY ("subscription_id","merchant_id") REFERENCES "public"."subscriptions"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_merchant_number_key" ON "quotes" USING btree ("merchant_id","number") WHERE "quotes"."number" is not null;--> statement-breakpoint
CREATE INDEX "quotes_merchant_id_id_idx" ON "quotes" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "quotes_customer_id_id_idx" ON "quotes" USING btree ("customer_id","id");--> statement-breakpoint
CREATE INDEX "quotes_open_expires_at_idx" ON "quotes" USING btree ("expires_at") WHERE "quotes"."status" = 'open';--> statement-breakpoint
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_next_quote_number_check" CHECK (next_quote_number >= 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'quote.created', 'quote.finalized', 'quote.accepted', 'quote.canceled', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billing_reason_check" CHECK (billing_reason in ('manual', 'subscription_create', 'subscription_cycle', 'subscription_update', 'subscription_cancel', 'upcoming', 'quote_accept')) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'quote.created', 'quote.finalized', 'quote.accepted', 'quote.canceled', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated']::text[]) NOT VALID;
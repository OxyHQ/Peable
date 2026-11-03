-- oxy:deploy-phase=pre
-- The native billing engine (ADR 0018): subscriptions, subscription items,
-- invoices, invoice lines and items, credit notes, the customer balance ledger,
-- test clocks, billing settings (numbering + dunning), meters and meter events,
-- entitlement features, product features and summaries, portal configurations
-- and sessions. New tables, plus additive columns on existing ones —
-- customers (balance, currency, test_clock_id), prices (meter_id),
-- customer_emails (invoice_id: invoice emails ride Orbit's one email outbox) —
-- and the event catalog's CHECKs widened for the billing event types.
-- HAND EDIT (the kind CONVENTIONS.md allows): every constraint added to an
-- EXISTING table is NOT VALID — customer_emails_invoice_fkey,
-- customer_emails_kind_check, customer_emails_subject_check,
-- customers_test_clock_fkey, customers_balance_check, prices_meter_fkey,
-- prices_recurring_check, events_type_check,
-- webhook_endpoints_enabled_events_check — so none scans under ACCESS EXCLUSIVE
-- (events is written inside every money transaction); every existing row
-- satisfies them (the old image writes none of the new values), and the post
-- migration after this one validates them under SHARE UPDATE EXCLUSIVE.
CREATE TABLE "billing_meter_events" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"meter_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"identifier" text NOT NULL,
	"event_name" text NOT NULL,
	"value" text NOT NULL,
	"payload" jsonb NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_meter_events_merchant_identifier_key" UNIQUE("merchant_id","identifier"),
	CONSTRAINT "billing_meter_events_value_check" CHECK (value ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "billing_meter_events_identifier_check" CHECK (char_length(identifier) between 1 and 100),
	CONSTRAINT "billing_meter_events_payload_check" CHECK (jsonb_typeof("billing_meter_events"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "billing_meters" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"event_name" text NOT NULL,
	"aggregation" text NOT NULL,
	"customer_payload_key" text DEFAULT 'peable_customer_id' NOT NULL,
	"value_payload_key" text DEFAULT 'value' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_meters_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "billing_meters_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "billing_meters_aggregation_check" CHECK (aggregation in ('sum', 'count', 'last')),
	CONSTRAINT "billing_meters_status_check" CHECK (status in ('active', 'inactive')),
	CONSTRAINT "billing_meters_names_check" CHECK (char_length(display_name) between 1 and 250 and event_name ~ '^[A-Za-z0-9_.:-]{1,100}$' and customer_payload_key ~ '^[A-Za-z0-9_]{1,100}$' and value_payload_key ~ '^[A-Za-z0-9_]{1,100}$' and customer_payload_key <> value_payload_key)
);
--> statement-breakpoint
CREATE TABLE "billing_portal_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"business_profile" jsonb NOT NULL,
	"default_return_url" text,
	"features" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_portal_configurations_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "billing_portal_configurations_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "billing_portal_configurations_json_check" CHECK (jsonb_typeof("billing_portal_configurations"."business_profile") = 'object' and jsonb_typeof("billing_portal_configurations"."features") = 'object' and jsonb_typeof("billing_portal_configurations"."metadata") = 'object'),
	CONSTRAINT "billing_portal_configurations_default_active_check" CHECK (active or not is_default),
	CONSTRAINT "billing_portal_configurations_return_url_check" CHECK (default_return_url is null or (default_return_url ~ '^https?://' and char_length(default_return_url) <= 2048))
);
--> statement-breakpoint
CREATE TABLE "billing_portal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"configuration_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"return_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_portal_sessions_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "billing_portal_sessions_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "billing_portal_sessions_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "billing_portal_sessions_return_url_check" CHECK (return_url is null or (return_url ~ '^https?://' and char_length(return_url) <= 2048))
);
--> statement-breakpoint
CREATE TABLE "billing_settings" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"invoice_prefix" text NOT NULL,
	"next_invoice_number" integer DEFAULT 1 NOT NULL,
	"default_days_until_due" integer DEFAULT 30 NOT NULL,
	"retry_schedule_days" integer[] DEFAULT '{1,3,5,7}'::integer[] NOT NULL,
	"final_action" text DEFAULT 'cancel' NOT NULL,
	"invoice_action" text DEFAULT 'mark_uncollectible' NOT NULL,
	"email_invoice_finalized" boolean DEFAULT true NOT NULL,
	"email_payment_failed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_settings_invoice_prefix_check" CHECK (invoice_prefix ~ '^[A-Z0-9]{3,12}$'),
	CONSTRAINT "billing_settings_next_invoice_number_check" CHECK (next_invoice_number >= 1),
	CONSTRAINT "billing_settings_days_until_due_check" CHECK (default_days_until_due between 0 and 365),
	CONSTRAINT "billing_settings_retry_schedule_check" CHECK (cardinality(retry_schedule_days) <= 8 and array_position(retry_schedule_days, null) is null and 1 <= all(retry_schedule_days) and 60 >= all(retry_schedule_days)),
	CONSTRAINT "billing_settings_final_action_check" CHECK (final_action in ('cancel', 'unpaid', 'past_due')),
	CONSTRAINT "billing_settings_invoice_action_check" CHECK (invoice_action in ('leave_open', 'mark_uncollectible'))
);
--> statement-breakpoint
CREATE TABLE "credit_note_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"credit_note_id" text NOT NULL,
	"type" text NOT NULL,
	"invoice_line_item_id" text,
	"description" text,
	"quantity" integer,
	"amount" text NOT NULL,
	"tax_amount" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "credit_note_lines_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "credit_note_lines_type_check" CHECK (type in ('invoice_line_item', 'custom_line_item')),
	CONSTRAINT "credit_note_lines_source_check" CHECK ((type = 'invoice_line_item') = (invoice_line_item_id is not null)),
	CONSTRAINT "credit_note_lines_amounts_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$' and tax_amount ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"type" text NOT NULL,
	"reason" text,
	"currency" text NOT NULL,
	"subtotal" text NOT NULL,
	"tax" text NOT NULL,
	"total" text NOT NULL,
	"refund_amount" text DEFAULT '0' NOT NULL,
	"credit_amount" text DEFAULT '0' NOT NULL,
	"out_of_band_amount" text DEFAULT '0' NOT NULL,
	"refund_id" text,
	"memo" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "credit_notes_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "credit_notes_merchant_number_key" UNIQUE("merchant_id","number"),
	CONSTRAINT "credit_notes_status_check" CHECK (status in ('issued', 'void')),
	CONSTRAINT "credit_notes_type_check" CHECK (type in ('pre_payment', 'post_payment')),
	CONSTRAINT "credit_notes_reason_check" CHECK (reason is null or reason in ('duplicate', 'fraudulent', 'order_change', 'product_unsatisfactory')),
	CONSTRAINT "credit_notes_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "credit_notes_amounts_check" CHECK (subtotal ~ '^(0|[1-9][0-9]*)$' and tax ~ '^(0|[1-9][0-9]*)$' and total ~ '^(0|[1-9][0-9]*)$' and refund_amount ~ '^(0|[1-9][0-9]*)$' and credit_amount ~ '^(0|[1-9][0-9]*)$' and out_of_band_amount ~ '^(0|[1-9][0-9]*)$' and total <> '0'),
	CONSTRAINT "credit_notes_distribution_check" CHECK (type = 'post_payment' or (refund_amount = '0' and credit_amount = '0' and out_of_band_amount = '0')),
	CONSTRAINT "credit_notes_voided_check" CHECK ((status = 'void') = (voided_at is not null)),
	CONSTRAINT "credit_notes_metadata_check" CHECK (jsonb_typeof("credit_notes"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "customer_balance_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"type" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"ending_balance" text NOT NULL,
	"description" text,
	"invoice_id" text,
	"credit_note_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "customer_balance_transactions_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "customer_balance_transactions_type_check" CHECK (type in ('adjustment', 'applied_to_invoice', 'credit_note', 'invoice_overpaid', 'unapplied_from_invoice')),
	CONSTRAINT "customer_balance_transactions_amounts_check" CHECK (amount ~ '^(0|-?[1-9][0-9]*)$' and amount <> '0' and ending_balance ~ '^(0|-?[1-9][0-9]*)$'),
	CONSTRAINT "customer_balance_transactions_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "customer_balance_transactions_metadata_check" CHECK (jsonb_typeof("customer_balance_transactions"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "customer_entitlement_summaries" (
	"customer_id" text PRIMARY KEY NOT NULL,
	"feature_ids" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entitlement_features" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"lookup_key" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "entitlement_features_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "entitlement_features_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "entitlement_features_merchant_lookup_key_key" UNIQUE("merchant_id","lookup_key"),
	CONSTRAINT "entitlement_features_lookup_key_check" CHECK (lookup_key ~ '^[A-Za-z0-9_.:-]{1,80}$'),
	CONSTRAINT "entitlement_features_name_check" CHECK (char_length(name) between 1 and 80),
	CONSTRAINT "entitlement_features_metadata_check" CHECK (jsonb_typeof("entitlement_features"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"invoice_id" text,
	"subscription_id" text,
	"subscription_item_id" text,
	"price_id" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_amount" text,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"description" text,
	"discountable" boolean DEFAULT true NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"proration" boolean DEFAULT false NOT NULL,
	"credits_line_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "invoice_items_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "invoice_items_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "invoice_items_amounts_check" CHECK (amount ~ '^(0|-?[1-9][0-9]*)$' and (unit_amount is null or unit_amount ~ '^(0|[1-9][0-9]*)$') and quantity >= 0 and (amount !~ '^-' or proration)),
	CONSTRAINT "invoice_items_period_check" CHECK (period_end >= period_start),
	CONSTRAINT "invoice_items_metadata_check" CHECK (jsonb_typeof("invoice_items"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"type" text NOT NULL,
	"subscription_id" text,
	"subscription_item_id" text,
	"invoice_item_id" text,
	"price_id" text,
	"quantity" integer,
	"amount" text NOT NULL,
	"discount_amount" text DEFAULT '0' NOT NULL,
	"tax_amounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"currency" text NOT NULL,
	"description" text,
	"discountable" boolean DEFAULT true NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"proration" boolean DEFAULT false NOT NULL,
	"credits_line_id" text,
	"metered" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "invoice_line_items_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "invoice_line_items_type_check" CHECK (type in ('subscription', 'invoiceitem')),
	CONSTRAINT "invoice_line_items_source_check" CHECK ((type = 'invoiceitem') = (invoice_item_id is not null) and (type <> 'subscription' or subscription_item_id is not null)),
	CONSTRAINT "invoice_line_items_amounts_check" CHECK (amount ~ '^(0|-?[1-9][0-9]*)$' and discount_amount ~ '^(0|-?[1-9][0-9]*)$' and jsonb_typeof(tax_amounts) = 'array' and (quantity is null or quantity >= 0)),
	CONSTRAINT "invoice_line_items_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "invoice_line_items_metadata_check" CHECK (jsonb_typeof("invoice_line_items"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"subscription_id" text,
	"test_clock_id" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"billing_reason" text NOT NULL,
	"collection_method" text NOT NULL,
	"currency" text NOT NULL,
	"number" text,
	"description" text,
	"auto_advance" boolean NOT NULL,
	"automatically_finalizes_at" timestamp with time zone,
	"days_until_due" integer,
	"due_date" timestamp with time zone,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"default_payment_method_id" text,
	"discount_coupon_id" text,
	"discount_promotion_code_id" text,
	"automatic_tax" boolean DEFAULT false NOT NULL,
	"automatic_tax_status" text,
	"tax_calculation_id" text,
	"taxed_lines_digest" text,
	"subtotal" text DEFAULT '0' NOT NULL,
	"total_discount" text DEFAULT '0' NOT NULL,
	"tax" text,
	"total" text DEFAULT '0' NOT NULL,
	"total_excluding_tax" text DEFAULT '0' NOT NULL,
	"starting_balance" text DEFAULT '0' NOT NULL,
	"ending_balance" text,
	"amount_due" text DEFAULT '0' NOT NULL,
	"amount_paid" text DEFAULT '0' NOT NULL,
	"pre_payment_credit_notes_amount" text DEFAULT '0' NOT NULL,
	"post_payment_credit_notes_amount" text DEFAULT '0' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_payment_attempt" timestamp with time zone,
	"payment_intent_id" text,
	"paid_out_of_band" boolean DEFAULT false NOT NULL,
	"customer_email" text,
	"customer_name" text,
	"hosted_token" text,
	"finalized_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"marked_uncollectible_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"dunning_exhausted_at" timestamp with time zone,
	"last_finalization_error" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_action_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "invoices_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "invoices_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "invoices_id_subscription_id_key" UNIQUE("id","subscription_id"),
	CONSTRAINT "invoices_hosted_token_key" UNIQUE("hosted_token"),
	CONSTRAINT "invoices_status_check" CHECK (status in ('draft', 'open', 'paid', 'void', 'uncollectible')),
	CONSTRAINT "invoices_billing_reason_check" CHECK (billing_reason in ('manual', 'subscription_create', 'subscription_cycle', 'subscription_update', 'subscription_cancel', 'upcoming')),
	CONSTRAINT "invoices_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "invoices_collection_method_check" CHECK (collection_method in ('charge_automatically', 'send_invoice')),
	CONSTRAINT "invoices_faircoin_sends_check" CHECK (currency <> 'FAIR' or (collection_method = 'send_invoice' and default_payment_method_id is null)),
	CONSTRAINT "invoices_amounts_check" CHECK (subtotal ~ '^(0|-?[1-9][0-9]*)$' and total_discount ~ '^(0|-?[1-9][0-9]*)$' and (tax is null or tax ~ '^(0|-?[1-9][0-9]*)$') and total ~ '^(0|-?[1-9][0-9]*)$' and total_excluding_tax ~ '^(0|-?[1-9][0-9]*)$' and starting_balance ~ '^(0|-?[1-9][0-9]*)$' and (ending_balance is null or ending_balance ~ '^(0|-?[1-9][0-9]*)$') and amount_due ~ '^(0|[1-9][0-9]*)$' and amount_paid ~ '^(0|[1-9][0-9]*)$' and pre_payment_credit_notes_amount ~ '^(0|[1-9][0-9]*)$' and post_payment_credit_notes_amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "invoices_finalized_check" CHECK ((status = 'draft') = (number is null) and (number is null) = (hosted_token is null) and (number is null) = (finalized_at is null) and (number is null) = (ending_balance is null)),
	CONSTRAINT "invoices_status_transitions_check" CHECK ((status = 'paid') = (paid_at is not null) and (status = 'void') = (voided_at is not null) and (marked_uncollectible_at is not null or status <> 'uncollectible')),
	CONSTRAINT "invoices_automatic_tax_check" CHECK ((automatic_tax_status is null or automatic_tax_status in ('complete', 'requires_location_inputs', 'failed')) and (automatic_tax or (automatic_tax_status is null and tax_calculation_id is null)) and (status = 'draft' or not automatic_tax or automatic_tax_status = 'complete')),
	CONSTRAINT "invoices_days_until_due_check" CHECK (days_until_due is null or days_until_due between 0 and 365),
	CONSTRAINT "invoices_attempt_count_check" CHECK (attempt_count >= 0),
	CONSTRAINT "invoices_period_check" CHECK (period_end >= period_start),
	CONSTRAINT "invoices_metadata_check" CHECK (jsonb_typeof("invoices"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "product_features" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"product_id" text NOT NULL,
	"feature_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "product_features_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "product_features_product_feature_key" UNIQUE("product_id","feature_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_items" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"price_id" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "subscription_items_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "subscription_items_quantity_check" CHECK (quantity >= 0),
	CONSTRAINT "subscription_items_metadata_check" CHECK (jsonb_typeof("subscription_items"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"test_clock_id" text,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"collection_method" text NOT NULL,
	"days_until_due" integer,
	"default_payment_method_id" text,
	"description" text,
	"billing_cycle_anchor" timestamp with time zone NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"start_date" timestamp with time zone NOT NULL,
	"trial_start" timestamp with time zone,
	"trial_end" timestamp with time zone,
	"trial_will_end_sent_at" timestamp with time zone,
	"upcoming_notice_sent_at" timestamp with time zone,
	"trial_end_behavior" text DEFAULT 'create_invoice' NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"cancellation_reason" text,
	"cancellation_comment" text,
	"pause_behavior" text,
	"pause_resumes_at" timestamp with time zone,
	"automatic_tax" boolean DEFAULT false NOT NULL,
	"discount_coupon_id" text,
	"discount_promotion_code_id" text,
	"discount_start" timestamp with time zone,
	"discount_end" timestamp with time zone,
	"latest_invoice_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_action_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "subscriptions_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "subscriptions_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "subscriptions_id_customer_id_key" UNIQUE("id","customer_id"),
	CONSTRAINT "subscriptions_status_check" CHECK (status in ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'paused')),
	CONSTRAINT "subscriptions_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "subscriptions_collection_method_check" CHECK (collection_method in ('charge_automatically', 'send_invoice') and (collection_method = 'send_invoice') = (days_until_due is not null) and (days_until_due is null or days_until_due between 0 and 365)),
	CONSTRAINT "subscriptions_faircoin_sends_invoices_check" CHECK (currency <> 'FAIR' or (collection_method = 'send_invoice' and default_payment_method_id is null)),
	CONSTRAINT "subscriptions_period_check" CHECK (current_period_end > current_period_start),
	CONSTRAINT "subscriptions_trial_check" CHECK ((trial_start is null) = (trial_end is null) and (trial_end is null or trial_end >= trial_start) and trial_end_behavior in ('cancel', 'create_invoice', 'pause')),
	CONSTRAINT "subscriptions_canceled_check" CHECK ((status in ('canceled', 'incomplete_expired')) = (ended_at is not null) and (status <> 'canceled' or canceled_at is not null) and (cancellation_reason is null or cancellation_reason in ('cancellation_requested', 'payment_failed'))),
	CONSTRAINT "subscriptions_pause_check" CHECK ((pause_behavior is null or pause_behavior in ('keep_as_draft', 'mark_uncollectible', 'void')) and (pause_resumes_at is null or pause_behavior is not null)),
	CONSTRAINT "subscriptions_discount_check" CHECK ((discount_coupon_id is null) = (discount_start is null) and (discount_promotion_code_id is null or discount_coupon_id is not null) and (discount_end is null or discount_coupon_id is not null)),
	CONSTRAINT "subscriptions_metadata_check" CHECK (jsonb_typeof("subscriptions"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "test_clocks" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text,
	"frozen_time" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"deletes_after" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "test_clocks_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "test_clocks_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "test_clocks_status_check" CHECK (status in ('ready', 'advancing', 'internal_failure')),
	CONSTRAINT "test_clocks_name_check" CHECK (name is null or char_length(name) between 1 and 300)
);
--> statement-breakpoint
ALTER TABLE "customer_emails" DROP CONSTRAINT "customer_emails_kind_check";
--> statement-breakpoint
ALTER TABLE "customer_emails" DROP CONSTRAINT "customer_emails_subject_check";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";
--> statement-breakpoint
ALTER TABLE "prices" DROP CONSTRAINT "prices_recurring_check";
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";
--> statement-breakpoint
ALTER TABLE "customer_emails" ADD COLUMN "invoice_id" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "balance" text DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "currency" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "test_clock_id" text;
--> statement-breakpoint
ALTER TABLE "prices" ADD COLUMN "meter_id" text;
--> statement-breakpoint
ALTER TABLE "billing_meter_events" ADD CONSTRAINT "billing_meter_events_meter_fkey" FOREIGN KEY ("meter_id","merchant_id") REFERENCES "public"."billing_meters"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_meter_events" ADD CONSTRAINT "billing_meter_events_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_meters" ADD CONSTRAINT "billing_meters_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_portal_configurations" ADD CONSTRAINT "billing_portal_configurations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_portal_sessions" ADD CONSTRAINT "billing_portal_sessions_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_portal_sessions" ADD CONSTRAINT "billing_portal_sessions_configuration_fkey" FOREIGN KEY ("configuration_id","merchant_id") REFERENCES "public"."billing_portal_configurations"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_settings" ADD CONSTRAINT "billing_settings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_invoice_line_item_id_invoice_line_items_id_fk" FOREIGN KEY ("invoice_line_item_id") REFERENCES "public"."invoice_line_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_fkey" FOREIGN KEY ("invoice_id","merchant_id") REFERENCES "public"."invoices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_balance_transactions" ADD CONSTRAINT "customer_balance_transactions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_balance_transactions" ADD CONSTRAINT "customer_balance_transactions_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_balance_transactions" ADD CONSTRAINT "customer_balance_transactions_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "customer_entitlement_summaries" ADD CONSTRAINT "customer_entitlement_summaries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entitlement_features" ADD CONSTRAINT "entitlement_features_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_subscription_item_id_subscription_items_id_fk" FOREIGN KEY ("subscription_item_id") REFERENCES "public"."subscription_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_fkey" FOREIGN KEY ("invoice_id","merchant_id") REFERENCES "public"."invoices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_subscription_fkey" FOREIGN KEY ("subscription_id","customer_id") REFERENCES "public"."subscriptions"("id","customer_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_price_fkey" FOREIGN KEY ("price_id","merchant_id") REFERENCES "public"."prices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_credits_line_fkey" FOREIGN KEY ("credits_line_id") REFERENCES "public"."invoice_line_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_subscription_item_id_subscription_items_id_fk" FOREIGN KEY ("subscription_item_id") REFERENCES "public"."subscription_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_item_id_invoice_items_id_fk" FOREIGN KEY ("invoice_item_id") REFERENCES "public"."invoice_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_fkey" FOREIGN KEY ("invoice_id","merchant_id") REFERENCES "public"."invoices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_price_fkey" FOREIGN KEY ("price_id","merchant_id") REFERENCES "public"."prices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_credits_line_fkey" FOREIGN KEY ("credits_line_id") REFERENCES "public"."invoice_line_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_fkey" FOREIGN KEY ("subscription_id","customer_id") REFERENCES "public"."subscriptions"("id","customer_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_test_clock_fkey" FOREIGN KEY ("test_clock_id","merchant_id") REFERENCES "public"."test_clocks"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_default_payment_method_fkey" FOREIGN KEY ("default_payment_method_id","customer_id") REFERENCES "public"."payment_methods"("id","customer_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_discount_coupon_fkey" FOREIGN KEY ("discount_coupon_id","merchant_id") REFERENCES "public"."coupons"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_discount_promotion_code_fkey" FOREIGN KEY ("discount_promotion_code_id") REFERENCES "public"."promotion_codes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "product_features" ADD CONSTRAINT "product_features_product_fkey" FOREIGN KEY ("product_id","merchant_id") REFERENCES "public"."products"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "product_features" ADD CONSTRAINT "product_features_feature_fkey" FOREIGN KEY ("feature_id","merchant_id") REFERENCES "public"."entitlement_features"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_subscription_fkey" FOREIGN KEY ("subscription_id","merchant_id") REFERENCES "public"."subscriptions"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_items" ADD CONSTRAINT "subscription_items_price_fkey" FOREIGN KEY ("price_id","merchant_id") REFERENCES "public"."prices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_test_clock_fkey" FOREIGN KEY ("test_clock_id","merchant_id") REFERENCES "public"."test_clocks"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_default_payment_method_fkey" FOREIGN KEY ("default_payment_method_id","customer_id") REFERENCES "public"."payment_methods"("id","customer_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_discount_coupon_fkey" FOREIGN KEY ("discount_coupon_id","merchant_id") REFERENCES "public"."coupons"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_discount_promotion_code_fkey" FOREIGN KEY ("discount_promotion_code_id") REFERENCES "public"."promotion_codes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_latest_invoice_fkey" FOREIGN KEY ("latest_invoice_id","id") REFERENCES "public"."invoices"("id","subscription_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "test_clocks" ADD CONSTRAINT "test_clocks_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "billing_meter_events_meter_customer_timestamp_idx" ON "billing_meter_events" USING btree ("meter_id","customer_id","timestamp");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_meters_merchant_active_event_key" ON "billing_meters" USING btree ("merchant_id","event_name") WHERE "billing_meters"."status" = 'active';
--> statement-breakpoint
CREATE INDEX "billing_meters_merchant_id_id_idx" ON "billing_meters" USING btree ("merchant_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_portal_configurations_merchant_default_key" ON "billing_portal_configurations" USING btree ("merchant_id") WHERE "billing_portal_configurations"."is_default";
--> statement-breakpoint
CREATE INDEX "billing_portal_configurations_merchant_id_id_idx" ON "billing_portal_configurations" USING btree ("merchant_id","id");
--> statement-breakpoint
CREATE INDEX "billing_portal_sessions_customer_id_idx" ON "billing_portal_sessions" USING btree ("customer_id");
--> statement-breakpoint
CREATE INDEX "credit_note_lines_credit_note_id_idx" ON "credit_note_lines" USING btree ("credit_note_id");
--> statement-breakpoint
CREATE INDEX "credit_note_lines_invoice_line_item_id_idx" ON "credit_note_lines" USING btree ("invoice_line_item_id");
--> statement-breakpoint
CREATE INDEX "credit_notes_merchant_id_id_idx" ON "credit_notes" USING btree ("merchant_id","id");
--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_id_idx" ON "credit_notes" USING btree ("invoice_id");
--> statement-breakpoint
CREATE INDEX "customer_balance_transactions_customer_id_id_idx" ON "customer_balance_transactions" USING btree ("customer_id","id");
--> statement-breakpoint
CREATE INDEX "entitlement_features_merchant_id_id_idx" ON "entitlement_features" USING btree ("merchant_id","id");
--> statement-breakpoint
CREATE INDEX "invoice_items_merchant_id_id_idx" ON "invoice_items" USING btree ("merchant_id","id");
--> statement-breakpoint
CREATE INDEX "invoice_items_customer_pending_idx" ON "invoice_items" USING btree ("customer_id","id") WHERE "invoice_items"."invoice_id" is null;
--> statement-breakpoint
CREATE INDEX "invoice_items_invoice_id_idx" ON "invoice_items" USING btree ("invoice_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_line_items_invoice_item_key" ON "invoice_line_items" USING btree ("invoice_item_id") WHERE "invoice_line_items"."invoice_item_id" is not null;
--> statement-breakpoint
CREATE INDEX "invoice_line_items_invoice_id_idx" ON "invoice_line_items" USING btree ("invoice_id","id");
--> statement-breakpoint
CREATE INDEX "invoice_line_items_subscription_item_id_idx" ON "invoice_line_items" USING btree ("subscription_item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_merchant_number_key" ON "invoices" USING btree ("merchant_id","number") WHERE "invoices"."number" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_subscription_period_reason_key" ON "invoices" USING btree ("subscription_id","billing_reason","period_start") WHERE "invoices"."subscription_id" is not null and "invoices"."billing_reason" in ('subscription_create', 'subscription_cycle');
--> statement-breakpoint
CREATE INDEX "invoices_merchant_id_id_idx" ON "invoices" USING btree ("merchant_id","id");
--> statement-breakpoint
CREATE INDEX "invoices_customer_id_id_idx" ON "invoices" USING btree ("customer_id","id");
--> statement-breakpoint
CREATE INDEX "invoices_subscription_id_id_idx" ON "invoices" USING btree ("subscription_id","id");
--> statement-breakpoint
CREATE INDEX "invoices_payment_intent_id_idx" ON "invoices" USING btree ("payment_intent_id");
--> statement-breakpoint
CREATE INDEX "invoices_next_action_at_idx" ON "invoices" USING btree ("next_action_at") WHERE "invoices"."next_action_at" is not null;
--> statement-breakpoint
CREATE INDEX "product_features_feature_id_idx" ON "product_features" USING btree ("feature_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_items_subscription_price_key" ON "subscription_items" USING btree ("subscription_id","price_id") WHERE "subscription_items"."deleted_at" is null;
--> statement-breakpoint
CREATE INDEX "subscription_items_subscription_id_id_idx" ON "subscription_items" USING btree ("subscription_id","id");
--> statement-breakpoint
CREATE INDEX "subscription_items_price_id_idx" ON "subscription_items" USING btree ("price_id");
--> statement-breakpoint
CREATE INDEX "subscriptions_merchant_id_id_idx" ON "subscriptions" USING btree ("merchant_id","id");
--> statement-breakpoint
CREATE INDEX "subscriptions_customer_id_id_idx" ON "subscriptions" USING btree ("customer_id","id");
--> statement-breakpoint
CREATE INDEX "subscriptions_next_action_at_idx" ON "subscriptions" USING btree ("next_action_at") WHERE "subscriptions"."next_action_at" is not null;
--> statement-breakpoint
CREATE INDEX "test_clocks_merchant_id_id_idx" ON "test_clocks" USING btree ("merchant_id","id");
--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_invoice_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_test_clock_fkey" FOREIGN KEY ("test_clock_id","merchant_id") REFERENCES "public"."test_clocks"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_meter_fkey" FOREIGN KEY ("meter_id","merchant_id") REFERENCES "public"."billing_meters"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_kind_check" CHECK (kind in ('payment_receipt', 'refund_notice', 'checkout_confirmation', 'invoice', 'invoice_payment_failed')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_subject_check" CHECK (("customer_emails"."kind" = 'payment_receipt' and "customer_emails"."payment_intent_id" is not null and "customer_emails"."receipt_number" is not null)
        or ("customer_emails"."kind" = 'refund_notice' and "customer_emails"."refund_id" is not null)
        or ("customer_emails"."kind" = 'checkout_confirmation' and "customer_emails"."checkout_session_id" is not null)
        or ("customer_emails"."kind" in ('invoice', 'invoice_payment_failed') and "customer_emails"."invoice_id" is not null)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_balance_check" CHECK (balance ~ '^(0|-?[1-9][0-9]*)$' and (balance = '0' or currency is not null) and (currency is null or currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY'))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'webhook_endpoint.test')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_recurring_check" CHECK ((type = 'recurring') = (recurring_interval is not null) and (recurring_interval is null) = (recurring_interval_count is null) and (recurring_interval is null) = (recurring_usage_type is null) and (recurring_interval is null or recurring_interval in ('day', 'week', 'month', 'year')) and (recurring_usage_type is null or recurring_usage_type in ('licensed', 'metered')) and (recurring_interval_count is null or recurring_interval_count between 1 and case recurring_interval when 'day' then 1095 when 'week' then 156 when 'month' then 36 else 3 end) and (recurring_usage_type = 'metered') = (meter_id is not null)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created']::text[]) NOT VALID;

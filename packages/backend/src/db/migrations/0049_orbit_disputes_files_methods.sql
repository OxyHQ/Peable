-- oxy:deploy-phase=pre
-- Orbit Phase 2b — disputes with file evidence, Files over Oxy Files, payment
-- method breadth: the new tables and the DDL on tables that are not hot.
-- Hand edits:
--   * the `currency_check` drop/add of the hot tables `payment_intents` and
--     `checkout_sessions` moved to the next migration (hot-table DDL alone);
--   * `disputes_id_merchant_id_key` moved before the foreign keys: it is the
--     target of `dispute_evidence_files_dispute_fkey`, and drizzle emits it after;
--   * every CHECK re-added on an existing table is `NOT VALID` (each one only
--     WIDENS its set, so no stored row can fail it), validated in the post
--     migration.
CREATE TABLE "dispute_evidence_files" (
	"dispute_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"field" text NOT NULL,
	"file_id" text NOT NULL,
	"file_purpose" text DEFAULT 'dispute_evidence' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "dispute_evidence_files_pkey" PRIMARY KEY("dispute_id","field"),
	CONSTRAINT "dispute_evidence_files_field_check" CHECK (field in ('cancellation_policy', 'customer_communication', 'customer_signature', 'duplicate_charge_documentation', 'receipt', 'refund_policy', 'service_documentation', 'shipping_documentation', 'uncategorized_file')),
	CONSTRAINT "dispute_evidence_files_purpose_check" CHECK ("dispute_evidence_files"."file_purpose" = 'dispute_evidence')
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"purpose" text NOT NULL,
	"oxy_file_id" text NOT NULL,
	"filename" text,
	"size" integer NOT NULL,
	"type" text NOT NULL,
	"withheld" text,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"oxy_file_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "files_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "files_id_merchant_id_purpose_key" UNIQUE("id","merchant_id","purpose"),
	CONSTRAINT "files_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "files_purpose_check" CHECK (purpose in ('dispute_evidence', 'business_logo', 'identity_document', 'additional_verification')),
	CONSTRAINT "files_type_check" CHECK (type in ('pdf', 'png', 'jpg')),
	CONSTRAINT "files_withheld_check" CHECK (withheld is null or withheld in ('unavailable', 'private')),
	CONSTRAINT "files_removed_by_check" CHECK (removed_by is null or removed_by in ('file.deleted', 'file.blocked', 'file.lost')),
	CONSTRAINT "files_removed_agrees_check" CHECK (("files"."removed_at" is null) = ("files"."removed_by" is null)),
	CONSTRAINT "files_removed_not_withheld_check" CHECK ("files"."removed_at" is null or "files"."withheld" is null),
	CONSTRAINT "files_size_check" CHECK (size between 1 and 10485760),
	CONSTRAINT "files_filename_check" CHECK ("files"."filename" is null or length("files"."filename") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "payment_method_configuration_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"configuration_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"synced_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_method_configuration_bindings_config_provider_key" UNIQUE("configuration_id","provider"),
	CONSTRAINT "payment_method_configuration_bindings_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "payment_method_configuration_bindings_provider_check" CHECK (provider in ('stripe'))
);
--> statement-breakpoint
CREATE TABLE "payment_method_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_method_configurations_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "payment_method_configurations_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "payment_method_configurations_preferences_object_check" CHECK (jsonb_typeof("payment_method_configurations"."preferences") = 'object'),
	CONSTRAINT "payment_method_configurations_default_is_active_check" CHECK (not "payment_method_configurations"."is_default" or "payment_method_configurations"."active"),
	CONSTRAINT "payment_method_configurations_name_check" CHECK (length("payment_method_configurations"."name") between 1 and 100),
	CONSTRAINT "payment_method_configurations_version_check" CHECK ("payment_method_configurations"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "payment_method_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"domain_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"apple_pay_status" text DEFAULT 'inactive' NOT NULL,
	"apple_pay_error" text,
	"google_pay_status" text DEFAULT 'inactive' NOT NULL,
	"google_pay_error" text,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_method_domains_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "payment_method_domains_merchant_domain_key" UNIQUE("merchant_id","domain_name"),
	CONSTRAINT "payment_method_domains_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "payment_method_domains_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "payment_method_domains_apple_pay_status_check" CHECK (apple_pay_status in ('active', 'inactive')),
	CONSTRAINT "payment_method_domains_google_pay_status_check" CHECK (google_pay_status in ('active', 'inactive')),
	CONSTRAINT "payment_method_domains_domain_name_check" CHECK (length(domain_name) <= 253 and domain_name ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$')
);
--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_id_merchant_id_key" UNIQUE("id","merchant_id");
--> statement-breakpoint
ALTER TABLE "charges" DROP CONSTRAINT "charges_currency_check";
--> statement-breakpoint
ALTER TABLE "coupons" DROP CONSTRAINT "coupons_discount_check";
--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT "disputes_currency_check";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_intent_event_has_intent_check";
--> statement-breakpoint
ALTER TABLE "oxy_file_reconciliation_runs" DROP CONSTRAINT "oxy_file_reconciliation_runs_entity_type_check";
--> statement-breakpoint
ALTER TABLE "oxy_file_reference_syncs" DROP CONSTRAINT "oxy_file_reference_syncs_entity_type_check";
--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_currency_check";
--> statement-breakpoint
ALTER TABLE "prices" DROP CONSTRAINT "prices_currency_check";
--> statement-breakpoint
ALTER TABLE "promotion_codes" DROP CONSTRAINT "promotion_codes_minimum_amount_check";
--> statement-breakpoint
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_currency_check";
--> statement-breakpoint
ALTER TABLE "transfer_reversals" DROP CONSTRAINT "transfer_reversals_currency_check";
--> statement-breakpoint
ALTER TABLE "transfers" DROP CONSTRAINT "transfers_currency_check";
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";
--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "has_evidence" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "is_charge_refundable" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "disputes" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "dispute_evidence_files" ADD CONSTRAINT "dispute_evidence_files_dispute_fkey" FOREIGN KEY ("dispute_id","merchant_id") REFERENCES "public"."disputes"("id","merchant_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "dispute_evidence_files" ADD CONSTRAINT "dispute_evidence_files_file_fkey" FOREIGN KEY ("file_id","merchant_id","file_purpose") REFERENCES "public"."files"("id","merchant_id","purpose") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_method_configuration_bindings" ADD CONSTRAINT "payment_method_configuration_bindings_configuration_id_fkey" FOREIGN KEY ("configuration_id") REFERENCES "public"."payment_method_configurations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_method_configurations" ADD CONSTRAINT "payment_method_configurations_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_method_domains" ADD CONSTRAINT "payment_method_domains_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "dispute_evidence_files_file_id_idx" ON "dispute_evidence_files" USING btree ("file_id");
--> statement-breakpoint
CREATE INDEX "files_merchant_id_purpose_created_idx" ON "files" USING btree ("merchant_id","purpose","created_at");
--> statement-breakpoint
CREATE INDEX "files_oxy_file_id_idx" ON "files" USING btree ("oxy_file_id");
--> statement-breakpoint
CREATE INDEX "payment_method_configurations_merchant_id_idx" ON "payment_method_configurations" USING btree ("merchant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_method_configurations_one_default_key" ON "payment_method_configurations" USING btree ("merchant_id") WHERE "payment_method_configurations"."is_default";
--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_discount_check" CHECK ((percent_off_bps is null) <> (amount_off is null) and (amount_off is null) = (currency is null) and (percent_off_bps is null or percent_off_bps between 1 and 10000) and (amount_off is null or (amount_off ~ '^(0|[1-9][0-9]*)$' and amount_off <> '0')) and (currency is null or currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY'))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_metadata_object_check" CHECK (jsonb_typeof("disputes"."metadata") = 'object') NOT VALID;
--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'webhook_endpoint.test')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_intent_event_has_intent_check" CHECK ((type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed')) = (payment_intent_id is not null)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "oxy_file_reconciliation_runs" ADD CONSTRAINT "oxy_file_reconciliation_runs_entity_type_check" CHECK (entity_type in ('merchant_avatar', 'file')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "oxy_file_reference_syncs" ADD CONSTRAINT "oxy_file_reference_syncs_entity_type_check" CHECK (entity_type in ('merchant_avatar', 'file')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "promotion_codes" ADD CONSTRAINT "promotion_codes_minimum_amount_check" CHECK ((minimum_amount is null) = (minimum_amount_currency is null) and (minimum_amount is null or minimum_amount ~ '^(0|[1-9][0-9]*)$') and (minimum_amount_currency is null or minimum_amount_currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY'))) NOT VALID;
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "transfer_reversals" ADD CONSTRAINT "transfer_reversals_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated']::text[]) NOT VALID;

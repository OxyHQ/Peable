-- oxy:deploy-phase=pre
-- Peable Tax business compliance (ADR 0020), part 1 of 2: the eight new
-- tables (business profile, operating locations, sales destinations,
-- registration declarations, documents, assessments, review items, action
-- history), the `tax_document` file purpose, and the event catalog widened
-- for tax.assessment.created / tax.review_item.created / .updated.
-- Additive for the image still serving: nothing it reads changes.
-- HAND EDIT: the three CHECKs re-added to existing tables (events, files,
-- webhook_endpoints) are NOT VALID, so none scans under ACCESS EXCLUSIVE;
-- the next migration (post) validates them under SHARE UPDATE EXCLUSIVE.
-- Every one only widens its set, so every existing row already satisfies it.
CREATE TABLE "tax_business_profiles" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"entity_type" text DEFAULT 'unknown' NOT NULL,
	"incorporation_country" text,
	"incorporation_state" text,
	"fiscal_year_end_month" integer,
	"customer_types" text DEFAULT 'unknown' NOT NULL,
	"supply_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_business_profiles_entity_type_check" CHECK (entity_type in ('corporation', 'limited_liability_company', 'partnership', 'sole_proprietorship', 'nonprofit', 'public_body', 'other', 'unknown')),
	CONSTRAINT "tax_business_profiles_customer_types_check" CHECK (customer_types in ('consumers', 'businesses', 'both', 'unknown')),
	CONSTRAINT "tax_business_profiles_country_check" CHECK (incorporation_country is null or incorporation_country ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_business_profiles_state_check" CHECK (incorporation_state is null or incorporation_state ~ '^[A-Z0-9]{1,3}$'),
	CONSTRAINT "tax_business_profiles_fiscal_month_check" CHECK (fiscal_year_end_month is null or fiscal_year_end_month between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "tax_compliance_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"object_type" text NOT NULL,
	"object_id" text,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_compliance_actions_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_compliance_actions_actor_check" CHECK (actor_type in ('user', 'service', 'system'))
);
--> statement-breakpoint
CREATE TABLE "tax_compliance_assessments" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"rule_set_version" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"inputs" jsonb NOT NULL,
	"inputs_digest" text NOT NULL,
	"results" jsonb NOT NULL,
	"summary" jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_compliance_assessments_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_compliance_assessments_actor_check" CHECK (actor_type in ('user', 'service', 'system')),
	CONSTRAINT "tax_compliance_assessments_digest_check" CHECK ("tax_compliance_assessments"."inputs_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "tax_compliance_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"file_id" text NOT NULL,
	"file_purpose" text DEFAULT 'tax_document' NOT NULL,
	"kind" text NOT NULL,
	"country" text,
	"state" text,
	"declaration_id" text,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_compliance_documents_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_compliance_documents_file_key" UNIQUE("file_id"),
	CONSTRAINT "tax_compliance_documents_purpose_check" CHECK ("tax_compliance_documents"."file_purpose" = 'tax_document'),
	CONSTRAINT "tax_compliance_documents_kind_check" CHECK (kind in ('registration_certificate', 'authority_correspondence', 'incorporation_record', 'filing_confirmation', 'payment_receipt', 'other')),
	CONSTRAINT "tax_compliance_documents_country_check" CHECK (country is null or country ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_compliance_documents_state_check" CHECK (state is null or state ~ '^[A-Z0-9]{1,3}$')
);
--> statement-breakpoint
CREATE TABLE "tax_operating_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"kind" text NOT NULL,
	"country" text NOT NULL,
	"state" text,
	"description" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_operating_locations_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_operating_locations_kind_check" CHECK (kind in ('head_office', 'fixed_establishment', 'office', 'warehouse', 'employees', 'inventory', 'other')),
	CONSTRAINT "tax_operating_locations_country_check" CHECK (country ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_operating_locations_state_check" CHECK (state is null or state ~ '^[A-Z0-9]{1,3}$'),
	CONSTRAINT "tax_operating_locations_period_check" CHECK ("tax_operating_locations"."ended_at" IS NULL OR "tax_operating_locations"."started_at" IS NULL OR "tax_operating_locations"."ended_at" > "tax_operating_locations"."started_at")
);
--> statement-breakpoint
CREATE TABLE "tax_registration_declarations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"country" text NOT NULL,
	"state" text,
	"scheme" text,
	"status" text NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"filing_frequency" text DEFAULT 'unknown' NOT NULL,
	"collection_registration_id" text,
	"note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_registration_declarations_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_registration_declarations_country_check" CHECK (country ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_registration_declarations_state_check" CHECK (state is null or state ~ '^[A-Z0-9]{1,3}$'),
	CONSTRAINT "tax_registration_declarations_scheme_check" CHECK (scheme is null or scheme in ('standard', 'simplified', 'eu_oss_union', 'eu_oss_non_union', 'us_state_sales_tax', 'ca_provincial')),
	CONSTRAINT "tax_registration_declarations_status_check" CHECK (status in ('unknown', 'not_registered', 'application_pending', 'registered', 'rejected', 'ended')),
	CONSTRAINT "tax_registration_declarations_frequency_check" CHECK (filing_frequency in ('monthly', 'quarterly', 'annual', 'unknown')),
	CONSTRAINT "tax_registration_declarations_registered_dated_check" CHECK ("tax_registration_declarations"."status" NOT IN ('registered', 'ended') OR "tax_registration_declarations"."effective_from" IS NOT NULL),
	CONSTRAINT "tax_registration_declarations_ended_dated_check" CHECK ("tax_registration_declarations"."status" <> 'ended' OR "tax_registration_declarations"."effective_to" IS NOT NULL),
	CONSTRAINT "tax_registration_declarations_period_check" CHECK ("tax_registration_declarations"."effective_to" IS NULL OR "tax_registration_declarations"."effective_from" IS NULL OR "tax_registration_declarations"."effective_to" > "tax_registration_declarations"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "tax_review_items" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"rule" text,
	"country" text,
	"state" text,
	"message" text NOT NULL,
	"first_assessment_id" text,
	"latest_assessment_id" text,
	"decision" text,
	"decision_note" text,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_review_items_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_review_items_status_check" CHECK (status in ('open', 'resolved', 'dismissed')),
	CONSTRAINT "tax_review_items_severity_check" CHECK (severity in ('action_required', 'review')),
	CONSTRAINT "tax_review_items_decision_check" CHECK (decision is null or decision in ('will_register', 'registered_outside_peable', 'not_required', 'accepted_risk', 'facts_corrected', 'dismissed')),
	CONSTRAINT "tax_review_items_decided_check" CHECK (("tax_review_items"."status" = 'open') = ("tax_review_items"."decision" IS NULL) AND ("tax_review_items"."decision" IS NULL) = ("tax_review_items"."decided_by" IS NULL) AND ("tax_review_items"."decision" IS NULL) = ("tax_review_items"."decided_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "tax_sales_destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"country" text NOT NULL,
	"state" text,
	"customer_types" text DEFAULT 'unknown' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_sales_destinations_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_sales_destinations_country_check" CHECK (country ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_sales_destinations_state_check" CHECK (state is null or state ~ '^[A-Z0-9]{1,3}$'),
	CONSTRAINT "tax_sales_destinations_customer_types_check" CHECK (customer_types in ('consumers', 'businesses', 'both', 'unknown')),
	CONSTRAINT "tax_sales_destinations_period_check" CHECK ("tax_sales_destinations"."ended_at" IS NULL OR "tax_sales_destinations"."started_at" IS NULL OR "tax_sales_destinations"."ended_at" > "tax_sales_destinations"."started_at")
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "files" DROP CONSTRAINT "files_purpose_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "tax_business_profiles" ADD CONSTRAINT "tax_business_profiles_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliance_actions" ADD CONSTRAINT "tax_compliance_actions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliance_assessments" ADD CONSTRAINT "tax_compliance_assessments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliance_documents" ADD CONSTRAINT "tax_compliance_documents_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliance_documents" ADD CONSTRAINT "tax_compliance_documents_file_fkey" FOREIGN KEY ("file_id","merchant_id","file_purpose") REFERENCES "public"."files"("id","merchant_id","purpose") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliance_documents" ADD CONSTRAINT "tax_compliance_documents_declaration_fkey" FOREIGN KEY ("declaration_id") REFERENCES "public"."tax_registration_declarations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_operating_locations" ADD CONSTRAINT "tax_operating_locations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_registration_declarations" ADD CONSTRAINT "tax_registration_declarations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_registration_declarations" ADD CONSTRAINT "tax_registration_declarations_collection_fkey" FOREIGN KEY ("collection_registration_id") REFERENCES "public"."tax_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_review_items" ADD CONSTRAINT "tax_review_items_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_review_items" ADD CONSTRAINT "tax_review_items_first_assessment_fkey" FOREIGN KEY ("first_assessment_id") REFERENCES "public"."tax_compliance_assessments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_review_items" ADD CONSTRAINT "tax_review_items_latest_assessment_fkey" FOREIGN KEY ("latest_assessment_id") REFERENCES "public"."tax_compliance_assessments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_sales_destinations" ADD CONSTRAINT "tax_sales_destinations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_compliance_actions_merchant_idx" ON "tax_compliance_actions" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "tax_compliance_assessments_merchant_idx" ON "tax_compliance_assessments" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "tax_compliance_documents_merchant_idx" ON "tax_compliance_documents" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "tax_operating_locations_merchant_idx" ON "tax_operating_locations" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "tax_registration_declarations_merchant_idx" ON "tax_registration_declarations" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_review_items_open_key" ON "tax_review_items" USING btree ("merchant_id","dedupe_key") WHERE "tax_review_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "tax_review_items_merchant_idx" ON "tax_review_items" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "tax_sales_destinations_merchant_idx" ON "tax_sales_destinations" USING btree ("merchant_id","id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_purpose_check" CHECK (purpose in ('dispute_evidence', 'business_logo', 'identity_document', 'additional_verification', 'finance_report_run', 'tax_document')) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated']::text[]) NOT VALID;
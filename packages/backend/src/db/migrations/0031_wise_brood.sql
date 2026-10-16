-- oxy:deploy-phase=pre
-- Peable Tax: six new tables. Nothing existing changes shape; the only lock on
-- a live table is the brief SHARE ROW EXCLUSIVE each new foreign key takes on
-- "merchants". Bounded so a busy merchants table makes this fail fast and
-- retry instead of queueing writes behind it on the shared RDS.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "tax_calculations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"evidence_id" text NOT NULL,
	"registration_id" text,
	"collection" text NOT NULL,
	"currency" text NOT NULL,
	"country" text NOT NULL,
	"state" text,
	"provider" text,
	"provider_ref" text,
	"result" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_calculations_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_calculations_collection_check" CHECK (collection in ('collect', 'not_registered', 'nontaxable')),
	CONSTRAINT "tax_calculations_collect_has_registration_check" CHECK ("tax_calculations"."collection" <> 'collect' OR ("tax_calculations"."registration_id" IS NOT NULL AND "tax_calculations"."provider" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tax_location_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_ref" text NOT NULL,
	"status" text NOT NULL,
	"rule" text NOT NULL,
	"country" text,
	"state" text,
	"items" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_location_evidence_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_location_evidence_status_check" CHECK (status in ('sufficient', 'insufficient', 'conflicting')),
	CONSTRAINT "tax_location_evidence_sufficient_has_country_check" CHECK ("tax_location_evidence"."status" <> 'sufficient' OR "tax_location_evidence"."country" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "tax_product_codes" (
	"merchant_id" text NOT NULL,
	"product_ref" text NOT NULL,
	"tax_code" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_product_codes_merchant_id_product_ref_pk" PRIMARY KEY("merchant_id","product_ref")
);
--> statement-breakpoint
CREATE TABLE "tax_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"country" text NOT NULL,
	"state" text,
	"scheme" text NOT NULL,
	"registration_number" text,
	"active_from" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"provider_ref" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_registrations_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_registrations_scheme_check" CHECK (scheme in ('standard', 'simplified', 'eu_oss_union', 'eu_oss_non_union', 'us_state_sales_tax', 'ca_provincial')),
	CONSTRAINT "tax_registrations_country_check" CHECK ("tax_registrations"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "tax_registrations_approved_is_dated_check" CHECK ("tax_registrations"."approved_at" IS NULL OR "tax_registrations"."active_from" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "tax_settings" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"legal_name" text,
	"head_office" jsonb,
	"default_tax_code" text DEFAULT 'txcd_10000000' NOT NULL,
	"default_tax_behavior" text DEFAULT 'exclusive' NOT NULL,
	"calculation_account" text DEFAULT 'none' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_settings_status_check" CHECK (status in ('draft', 'active')),
	CONSTRAINT "tax_settings_behavior_check" CHECK (default_tax_behavior in ('inclusive', 'exclusive')),
	CONSTRAINT "tax_settings_account_check" CHECK (calculation_account in ('platform', 'none')),
	CONSTRAINT "tax_settings_active_is_approved_check" CHECK ("tax_settings"."status" <> 'active' OR ("tax_settings"."approved_at" IS NOT NULL AND "tax_settings"."approved_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tax_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"calculation_id" text NOT NULL,
	"reference" text NOT NULL,
	"rail" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "tax_transactions_publicId_unique" UNIQUE("public_id"),
	CONSTRAINT "tax_transactions_calculationId_unique" UNIQUE("calculation_id"),
	CONSTRAINT "tax_transactions_reference_key" UNIQUE("merchant_id","reference")
);
--> statement-breakpoint
ALTER TABLE "tax_calculations" ADD CONSTRAINT "tax_calculations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_calculations" ADD CONSTRAINT "tax_calculations_evidence_id_tax_location_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."tax_location_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_calculations" ADD CONSTRAINT "tax_calculations_registration_id_tax_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."tax_registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_location_evidence" ADD CONSTRAINT "tax_location_evidence_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_product_codes" ADD CONSTRAINT "tax_product_codes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_registrations" ADD CONSTRAINT "tax_registrations_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_settings" ADD CONSTRAINT "tax_settings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_calculation_id_tax_calculations_id_fk" FOREIGN KEY ("calculation_id") REFERENCES "public"."tax_calculations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_registrations_merchant_idx" ON "tax_registrations" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "tax_transactions_merchant_committed_idx" ON "tax_transactions" USING btree ("merchant_id","committed_at");
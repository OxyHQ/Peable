-- oxy:deploy-phase=pre
-- The catalog (ADR 0018): products, prices, coupons (+ coupon_products) and
-- promotion codes. New tables only, plus the event catalog's two CHECKs widened
-- for the ten catalog event types — additive for the image still serving.
-- HAND EDIT: the re-added events_type_check and
-- webhook_endpoints_enabled_events_check are NOT VALID, so neither scan holds
-- ACCESS EXCLUSIVE on events (written inside every money transaction); every
-- existing row satisfies a widened set, and the post migration after this one
-- validates both under SHARE UPDATE EXCLUSIVE.
CREATE TABLE "coupon_products" (
	"coupon_id" text NOT NULL,
	"product_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	CONSTRAINT "coupon_products_coupon_id_product_id_pk" PRIMARY KEY("coupon_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"name" text,
	"percent_off_bps" integer,
	"amount_off" text,
	"currency" text,
	"duration" text NOT NULL,
	"duration_in_months" integer,
	"max_redemptions" integer,
	"redeem_by" timestamp with time zone,
	"times_redeemed" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "coupons_merchant_public_id_key" UNIQUE("merchant_id","public_id"),
	CONSTRAINT "coupons_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "coupons_public_id_check" CHECK (public_id ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "coupons_name_check" CHECK (name is null or char_length(name) between 1 and 40),
	CONSTRAINT "coupons_discount_check" CHECK ((percent_off_bps is null) <> (amount_off is null) and (amount_off is null) = (currency is null) and (percent_off_bps is null or percent_off_bps between 1 and 10000) and (amount_off is null or (amount_off ~ '^(0|[1-9][0-9]*)$' and amount_off <> '0')) and (currency is null or currency in ('FAIR', 'EUR', 'USD'))),
	CONSTRAINT "coupons_duration_check" CHECK (duration in ('once', 'repeating', 'forever') and (duration = 'repeating') = (duration_in_months is not null) and (duration_in_months is null or duration_in_months between 1 and 1200)),
	CONSTRAINT "coupons_redemptions_check" CHECK (("coupons"."max_redemptions" is null or "coupons"."max_redemptions" >= 1) and "coupons"."times_redeemed" >= 0 and ("coupons"."max_redemptions" is null or "coupons"."times_redeemed" <= "coupons"."max_redemptions")),
	CONSTRAINT "coupons_metadata_check" CHECK (jsonb_typeof("coupons"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"product_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"currency" text NOT NULL,
	"unit_amount" text,
	"billing_scheme" text NOT NULL,
	"tiers" jsonb,
	"tiers_mode" text,
	"transform_quantity_divide_by" integer,
	"transform_quantity_round" text,
	"type" text NOT NULL,
	"recurring_interval" text,
	"recurring_interval_count" integer,
	"recurring_usage_type" text,
	"tax_behavior" text DEFAULT 'unspecified' NOT NULL,
	"lookup_key" text,
	"nickname" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "prices_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "prices_id_product_id_key" UNIQUE("id","product_id"),
	CONSTRAINT "prices_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD')),
	CONSTRAINT "prices_unit_amount_check" CHECK (unit_amount is null or unit_amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "prices_billing_scheme_check" CHECK (billing_scheme in ('per_unit', 'tiered')),
	CONSTRAINT "prices_tiers_mode_check" CHECK (tiers_mode is null or tiers_mode in ('graduated', 'volume')),
	CONSTRAINT "prices_type_check" CHECK (type in ('one_time', 'recurring')),
	CONSTRAINT "prices_tax_behavior_check" CHECK (tax_behavior in ('inclusive', 'exclusive', 'unspecified')),
	CONSTRAINT "prices_billing_scheme_shape_check" CHECK ((billing_scheme = 'per_unit') = (unit_amount is not null) and (billing_scheme = 'tiered') = (tiers is not null) and (tiers is null) = (tiers_mode is null)),
	CONSTRAINT "prices_tiers_check" CHECK (tiers is null or (jsonb_typeof(tiers) = 'array' and jsonb_array_length(tiers) between 1 and 250)),
	CONSTRAINT "prices_transform_quantity_check" CHECK ((transform_quantity_divide_by is null) = (transform_quantity_round is null) and (transform_quantity_divide_by is null or (transform_quantity_divide_by >= 1 and billing_scheme = 'per_unit')) and (transform_quantity_round is null or transform_quantity_round in ('up', 'down'))),
	CONSTRAINT "prices_recurring_check" CHECK ((type = 'recurring') = (recurring_interval is not null) and (recurring_interval is null) = (recurring_interval_count is null) and (recurring_interval is null) = (recurring_usage_type is null) and (recurring_interval is null or recurring_interval in ('day', 'week', 'month', 'year')) and (recurring_usage_type is null or recurring_usage_type in ('licensed', 'metered')) and (recurring_interval_count is null or recurring_interval_count between 1 and case recurring_interval when 'day' then 1095 when 'week' then 156 when 'month' then 36 else 3 end)),
	CONSTRAINT "prices_lookup_key_check" CHECK (lookup_key is null or char_length(lookup_key) between 1 and 200),
	CONSTRAINT "prices_nickname_check" CHECK (nickname is null or char_length(nickname) between 1 and 250),
	CONSTRAINT "prices_metadata_check" CHECK (jsonb_typeof("prices"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"images" text[] DEFAULT '{}'::text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tax_code" text,
	"default_price_id" text,
	"unit_label" text,
	"url" text,
	"statement_descriptor" text,
	"marketing_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "products_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "products_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "products_name_check" CHECK (char_length(name) between 1 and 250),
	CONSTRAINT "products_description_check" CHECK (description is null or char_length(description) between 1 and 40000),
	CONSTRAINT "products_images_check" CHECK (cardinality(images) <= 8),
	CONSTRAINT "products_metadata_check" CHECK (jsonb_typeof("products"."metadata") = 'object'),
	CONSTRAINT "products_tax_code_check" CHECK (tax_code is null or tax_code ~ '^txcd_[0-9]{8}$'),
	CONSTRAINT "products_unit_label_check" CHECK (unit_label is null or char_length(unit_label) between 1 and 12),
	CONSTRAINT "products_url_check" CHECK (url is null or (url ~ '^https?://' and char_length(url) <= 2048)),
	CONSTRAINT "products_statement_descriptor_check" CHECK (statement_descriptor is null or char_length(statement_descriptor) between 1 and 22),
	CONSTRAINT "products_marketing_features_check" CHECK (jsonb_typeof(marketing_features) = 'array' and jsonb_array_length(marketing_features) <= 15)
);
--> statement-breakpoint
CREATE TABLE "promotion_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"coupon_id" text NOT NULL,
	"customer_id" text,
	"code" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"max_redemptions" integer,
	"expires_at" timestamp with time zone,
	"times_redeemed" integer DEFAULT 0 NOT NULL,
	"first_time_transaction" boolean DEFAULT false NOT NULL,
	"minimum_amount" text,
	"minimum_amount_currency" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "promotion_codes_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "promotion_codes_code_check" CHECK (code ~ '^[A-Za-z0-9]{1,64}$'),
	CONSTRAINT "promotion_codes_redemptions_check" CHECK (("promotion_codes"."max_redemptions" is null or "promotion_codes"."max_redemptions" >= 1) and "promotion_codes"."times_redeemed" >= 0 and ("promotion_codes"."max_redemptions" is null or "promotion_codes"."times_redeemed" <= "promotion_codes"."max_redemptions")),
	CONSTRAINT "promotion_codes_minimum_amount_check" CHECK ((minimum_amount is null) = (minimum_amount_currency is null) and (minimum_amount is null or minimum_amount ~ '^(0|[1-9][0-9]*)$') and (minimum_amount_currency is null or minimum_amount_currency in ('FAIR', 'EUR', 'USD'))),
	CONSTRAINT "promotion_codes_metadata_check" CHECK (jsonb_typeof("promotion_codes"."metadata") = 'object')
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "coupon_products" ADD CONSTRAINT "coupon_products_coupon_fkey" FOREIGN KEY ("coupon_id","merchant_id") REFERENCES "public"."coupons"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_products" ADD CONSTRAINT "coupon_products_product_fkey" FOREIGN KEY ("product_id","merchant_id") REFERENCES "public"."products"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_product_merchant_fkey" FOREIGN KEY ("product_id","merchant_id") REFERENCES "public"."products"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_default_price_fkey" FOREIGN KEY ("default_price_id","id") REFERENCES "public"."prices"("id","product_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_codes" ADD CONSTRAINT "promotion_codes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_codes" ADD CONSTRAINT "promotion_codes_coupon_fkey" FOREIGN KEY ("coupon_id","merchant_id") REFERENCES "public"."coupons"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotion_codes" ADD CONSTRAINT "promotion_codes_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupon_products_product_id_idx" ON "coupon_products" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "coupons_merchant_id_id_idx" ON "coupons" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "prices_merchant_lookup_key_key" ON "prices" USING btree ("merchant_id","lookup_key") WHERE "prices"."lookup_key" is not null;--> statement-breakpoint
CREATE INDEX "prices_merchant_id_id_idx" ON "prices" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "prices_product_id_id_idx" ON "prices" USING btree ("product_id","id");--> statement-breakpoint
CREATE INDEX "products_merchant_id_id_idx" ON "products" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_codes_merchant_active_code_key" ON "promotion_codes" USING btree ("merchant_id",lower("code")) WHERE "promotion_codes"."active";--> statement-breakpoint
CREATE INDEX "promotion_codes_merchant_id_id_idx" ON "promotion_codes" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "promotion_codes_coupon_id_idx" ON "promotion_codes" USING btree ("coupon_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated']::text[]) NOT VALID;
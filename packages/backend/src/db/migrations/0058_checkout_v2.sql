-- oxy:deploy-phase=pre
-- Orbit Phase 3 (checkout v2), part 1 of 3: the new tables (session line
-- items, payment link line items, merchant branding, email settings, the
-- customer-email outbox), payment_links' new options, and the event catalog's
-- two CHECKs widened for the checkout.session.* and payment_link.* types.
-- Additive for the image still serving: every new column is nullable or
-- defaulted, and payment_links.amount only loses NOT NULL.
-- HAND EDIT 1: the two `ADD CONSTRAINT … UNIQUE` (prices, promotion_codes)
-- were moved above the foreign keys that reference them — drizzle-kit emits
-- them after (CONVENTIONS.md §Composite foreign keys).
-- HAND EDIT 2: every CHECK added to an existing table is NOT VALID, so none
-- scans under ACCESS EXCLUSIVE (events is written inside every money
-- transaction); payment_links_amount_shape_check is also refused by the
-- pre-Phase-3 links until checkout_v2_data migrates them, and that post migration validates them all.
CREATE TABLE "checkout_session_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"session_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"position" integer NOT NULL,
	"price_id" text,
	"product_id" text,
	"description" text NOT NULL,
	"images" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tax_code" text,
	"tax_behavior" text DEFAULT 'unspecified' NOT NULL,
	"currency" text NOT NULL,
	"price" jsonb NOT NULL,
	"quantity" integer NOT NULL,
	"adjustable_enabled" boolean DEFAULT false NOT NULL,
	"adjustable_minimum" integer,
	"adjustable_maximum" integer,
	"amount_subtotal" text NOT NULL,
	"amount_discount" text DEFAULT '0' NOT NULL,
	"amount_tax" text DEFAULT '0' NOT NULL,
	"amount_total" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "checkout_session_line_items_amounts_check" CHECK (amount_subtotal ~ '^(0|[1-9][0-9]*)$' and amount_discount ~ '^(0|[1-9][0-9]*)$' and amount_tax ~ '^(0|[1-9][0-9]*)$' and amount_total ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "checkout_session_line_items_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "checkout_session_line_items_tax_behavior_check" CHECK (tax_behavior in ('inclusive', 'exclusive', 'unspecified')),
	CONSTRAINT "checkout_session_line_items_quantity_check" CHECK ("checkout_session_line_items"."quantity" >= 0 and "checkout_session_line_items"."quantity" <= 999999 and (
        (not "checkout_session_line_items"."adjustable_enabled" and "checkout_session_line_items"."adjustable_minimum" is null and "checkout_session_line_items"."adjustable_maximum" is null and "checkout_session_line_items"."quantity" >= 1)
        or ("checkout_session_line_items"."adjustable_enabled" and "checkout_session_line_items"."adjustable_minimum" is not null and "checkout_session_line_items"."adjustable_maximum" is not null
          and "checkout_session_line_items"."adjustable_minimum" >= 0 and "checkout_session_line_items"."adjustable_minimum" <= "checkout_session_line_items"."adjustable_maximum"
          and "checkout_session_line_items"."quantity" between "checkout_session_line_items"."adjustable_minimum" and "checkout_session_line_items"."adjustable_maximum"))),
	CONSTRAINT "checkout_session_line_items_images_check" CHECK (jsonb_typeof("checkout_session_line_items"."images") = 'array' and jsonb_array_length("checkout_session_line_items"."images") <= 8)
);
--> statement-breakpoint
CREATE TABLE "customer_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"recipient" text NOT NULL,
	"payment_intent_id" text,
	"refund_id" text,
	"checkout_session_id" text,
	"receipt_number" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "customer_emails_kind_check" CHECK (kind in ('payment_receipt', 'refund_notice', 'checkout_confirmation')),
	CONSTRAINT "customer_emails_status_check" CHECK (status in ('pending', 'sent', 'failed', 'expired')),
	CONSTRAINT "customer_emails_subject_check" CHECK (("customer_emails"."kind" = 'payment_receipt' and "customer_emails"."payment_intent_id" is not null and "customer_emails"."receipt_number" is not null)
        or ("customer_emails"."kind" = 'refund_notice' and "customer_emails"."refund_id" is not null)
        or ("customer_emails"."kind" = 'checkout_confirmation' and "customer_emails"."checkout_session_id" is not null)),
	CONSTRAINT "customer_emails_sent_check" CHECK (("customer_emails"."status" = 'sent') = ("customer_emails"."sent_at" is not null)),
	CONSTRAINT "customer_emails_recipient_check" CHECK (length("customer_emails"."recipient") <= 254 and "customer_emails"."recipient" ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);
--> statement-breakpoint
CREATE TABLE "merchant_branding" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"use_avatar_as_icon" boolean DEFAULT true NOT NULL,
	"primary_color" text,
	"accent_color" text,
	"font" text,
	"border_style" text,
	"terms_of_service_url" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_branding_colors_check" CHECK (("merchant_branding"."primary_color" is null or "merchant_branding"."primary_color" ~ '^#[0-9a-f]{6}$') and ("merchant_branding"."accent_color" is null or "merchant_branding"."accent_color" ~ '^#[0-9a-f]{6}$')),
	CONSTRAINT "merchant_branding_font_check" CHECK (font is null or font in ('system', 'inter', 'roboto', 'open_sans', 'lato', 'source_sans', 'noto_sans', 'serif', 'monospace')),
	CONSTRAINT "merchant_branding_border_style_check" CHECK (border_style is null or border_style in ('rounded', 'rectangular', 'pill')),
	CONSTRAINT "merchant_branding_terms_url_check" CHECK ("merchant_branding"."terms_of_service_url" is null or ("merchant_branding"."terms_of_service_url" ~ '^https://' and length("merchant_branding"."terms_of_service_url") <= 2048))
);
--> statement-breakpoint
CREATE TABLE "merchant_email_settings" (
	"merchant_id" text PRIMARY KEY NOT NULL,
	"payment_receipts" boolean DEFAULT true NOT NULL,
	"refund_notices" boolean DEFAULT true NOT NULL,
	"checkout_confirmations" boolean DEFAULT false NOT NULL,
	"support_email" text,
	"next_receipt_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_email_settings_receipt_number_check" CHECK ("merchant_email_settings"."next_receipt_number" >= 1),
	CONSTRAINT "merchant_email_settings_support_email_check" CHECK ("merchant_email_settings"."support_email" is null or (length("merchant_email_settings"."support_email") <= 254 and "merchant_email_settings"."support_email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'))
);
--> statement-breakpoint
CREATE TABLE "payment_link_line_items" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"position" integer NOT NULL,
	"price_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"adjustable_enabled" boolean DEFAULT false NOT NULL,
	"adjustable_minimum" integer,
	"adjustable_maximum" integer,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_link_line_items_quantity_check" CHECK ("payment_link_line_items"."quantity" >= 1 and "payment_link_line_items"."quantity" <= 999999 and (
        (not "payment_link_line_items"."adjustable_enabled" and "payment_link_line_items"."adjustable_minimum" is null and "payment_link_line_items"."adjustable_maximum" is null)
        or ("payment_link_line_items"."adjustable_enabled" and "payment_link_line_items"."adjustable_minimum" is not null and "payment_link_line_items"."adjustable_maximum" is not null
          and "payment_link_line_items"."adjustable_minimum" >= 0 and "payment_link_line_items"."adjustable_minimum" <= "payment_link_line_items"."adjustable_maximum"
          and "payment_link_line_items"."quantity" between "payment_link_line_items"."adjustable_minimum" and "payment_link_line_items"."adjustable_maximum")))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_amount_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "payment_links" ALTER COLUMN "amount" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "allow_promotion_codes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "collection" jsonb;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "custom_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "automatic_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "customer_creation" text DEFAULT 'if_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "submit_type" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "after_completion_type" text DEFAULT 'hosted_confirmation' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "after_completion_url" text;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "after_completion_message" text;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "completed_sessions_limit" integer;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "completed_sessions_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_id_merchant_id_key" UNIQUE("id","merchant_id");--> statement-breakpoint
ALTER TABLE "promotion_codes" ADD CONSTRAINT "promotion_codes_id_merchant_id_key" UNIQUE("id","merchant_id");--> statement-breakpoint
ALTER TABLE "checkout_session_line_items" ADD CONSTRAINT "checkout_session_line_items_session_id_checkout_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_session_line_items" ADD CONSTRAINT "checkout_session_line_items_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_session_line_items" ADD CONSTRAINT "checkout_session_line_items_price_fkey" FOREIGN KEY ("price_id","merchant_id") REFERENCES "public"."prices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_session_line_items" ADD CONSTRAINT "checkout_session_line_items_product_fkey" FOREIGN KEY ("product_id","merchant_id") REFERENCES "public"."products"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_branding" ADD CONSTRAINT "merchant_branding_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_email_settings" ADD CONSTRAINT "merchant_email_settings_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_line_items" ADD CONSTRAINT "payment_link_line_items_link_id_payment_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."payment_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_line_items" ADD CONSTRAINT "payment_link_line_items_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_line_items" ADD CONSTRAINT "payment_link_line_items_price_fkey" FOREIGN KEY ("price_id","merchant_id") REFERENCES "public"."prices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_session_line_items_public_id_key" ON "checkout_session_line_items" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_session_line_items_session_position_key" ON "checkout_session_line_items" USING btree ("session_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_emails_dedupe_key" ON "customer_emails" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "customer_emails_pending_idx" ON "customer_emails" USING btree ("next_attempt_at") WHERE "customer_emails"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "customer_emails_merchant_id_idx" ON "customer_emails" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_link_line_items_link_position_key" ON "payment_link_line_items" USING btree ("link_id","position");--> statement-breakpoint
CREATE INDEX "payment_link_line_items_price_id_idx" ON "payment_link_line_items" USING btree ("price_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_amount_shape_check" CHECK (("payment_links"."contribution" is null) = ("payment_links"."amount" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_after_completion_check" CHECK (after_completion_type in ('redirect', 'hosted_confirmation') and ((after_completion_type = 'redirect') = (after_completion_url is not null)) and (after_completion_type = 'hosted_confirmation' or after_completion_message is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_completed_sessions_check" CHECK (("payment_links"."completed_sessions_limit" is null or "payment_links"."completed_sessions_limit" >= 1) and "payment_links"."completed_sessions_count" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_custom_fields_check" CHECK (jsonb_typeof("payment_links"."custom_fields") = 'array' and jsonb_array_length("payment_links"."custom_fields") <= 3) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_options_check" CHECK (customer_creation in ('always', 'if_required') and submit_type in ('auto', 'pay', 'book', 'donate') and (locale is null or locale in ('en', 'es', 'fr', 'de', 'it', 'pt'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_amount_check" CHECK (amount is null or amount ~ '^(0|[1-9][0-9]*)$') NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated']::text[]) NOT VALID;
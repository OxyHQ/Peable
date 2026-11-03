-- oxy:deploy-phase=pre
-- Orbit Phase 3 (checkout v2), part 2 of 3: checkout_sessions becomes an ORDER
-- (mode, status, totals, collection, discount, tax, customer, line items in
-- checkout_v2's table) whose payment is created when the payer confirms — so
-- payment_intent_id loses NOT NULL. Hot table, so this file holds only its
-- ACCESS EXCLUSIVE DDL: every column is nullable or has a constant default
-- (no rewrite), the indexes are checkout_sessions_indexes and the backfill checkout_v2_data.
-- HAND EDIT: every constraint added here (foreign keys and CHECKs) is
-- NOT VALID — the pre-Phase-3 rows have no client_secret or expires_at until
-- checkout_v2_data backfills them — and that post migration validates them.
ALTER TABLE "checkout_sessions" ALTER COLUMN "payment_intent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "mode" text DEFAULT 'payment' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "payment_status" text DEFAULT 'unpaid' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "ui_mode" text DEFAULT 'hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "submit_type" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "client_secret" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "setup_intent_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "amount_subtotal" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "amount_discount" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "amount_tax" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "amount_shipping" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "customer_email" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "customer_creation" text DEFAULT 'if_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "customer_details" jsonb;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "shipping_details" jsonb;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "collection" jsonb;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "custom_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "consent" jsonb;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "allow_promotion_codes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "coupon_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "promotion_code_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "automatic_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "automatic_tax_status" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "tax_calculation_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "client_reference_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "payment_link_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "confirmation_message" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "link_operation_key" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_setup_intent_id_setup_intents_id_fk" FOREIGN KEY ("setup_intent_id") REFERENCES "public"."setup_intents"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_payment_link_id_payment_links_id_fk" FOREIGN KEY ("payment_link_id") REFERENCES "public"."payment_links"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_coupon_fkey" FOREIGN KEY ("coupon_id","merchant_id") REFERENCES "public"."coupons"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_promotion_code_fkey" FOREIGN KEY ("promotion_code_id","merchant_id") REFERENCES "public"."promotion_codes"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_amounts_check" CHECK (amount_subtotal ~ '^(0|[1-9][0-9]*)$' and amount_discount ~ '^(0|[1-9][0-9]*)$' and amount_tax ~ '^(0|[1-9][0-9]*)$' and amount_shipping ~ '^(0|[1-9][0-9]*)$') NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_mode_check" CHECK (mode in ('payment', 'setup', 'subscription')) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_status_check" CHECK (status in ('open', 'complete', 'expired')) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_payment_status_check" CHECK (payment_status in ('paid', 'unpaid', 'no_payment_required')) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_ui_mode_check" CHECK (ui_mode in ('hosted', 'embedded')) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_locale_check" CHECK (locale is null or locale in ('en', 'es', 'fr', 'de', 'it', 'pt')) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_submit_type_check" CHECK (submit_type in ('auto', 'pay', 'book', 'donate')) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_customer_creation_check" CHECK (customer_creation in ('always', 'if_required')) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_automatic_tax_status_check" CHECK (automatic_tax_status is null or automatic_tax_status in ('complete', 'requires_location_inputs', 'failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_custom_fields_check" CHECK (jsonb_typeof("checkout_sessions"."custom_fields") = 'array' and jsonb_array_length("checkout_sessions"."custom_fields") <= 3) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_mode_objects_check" CHECK (("checkout_sessions"."mode" <> 'setup' or "checkout_sessions"."payment_intent_id" is null) and ("checkout_sessions"."mode" = 'setup' or "checkout_sessions"."setup_intent_id" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_status_instants_check" CHECK (("checkout_sessions"."status" = 'complete') = ("checkout_sessions"."completed_at" is not null) and ("checkout_sessions"."status" = 'expired') = ("checkout_sessions"."expired_at" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_payment_status_agrees_check" CHECK (("checkout_sessions"."mode" <> 'setup' or "checkout_sessions"."payment_status" = 'no_payment_required') and ("checkout_sessions"."payment_status" <> 'no_payment_required' or "checkout_sessions"."mode" = 'setup' or ("checkout_sessions"."status" = 'complete' and "checkout_sessions"."amount" = '0'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_discount_check" CHECK ("checkout_sessions"."promotion_code_id" is null or "checkout_sessions"."coupon_id" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_client_secret_check" CHECK ("checkout_sessions"."client_secret" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_expires_at_check" CHECK ("checkout_sessions"."expires_at" is not null) NOT VALID;
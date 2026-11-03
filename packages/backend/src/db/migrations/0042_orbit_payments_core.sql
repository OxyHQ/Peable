-- oxy:deploy-phase=pre
-- ADR 0019 — Orbit payments core, the DDL half. Hand edits:
--   * every constraint ADDED to the existing tables `payment_intents` (hot),
--     `events` and `webhook_endpoints` is `NOT VALID` — rows still carry the
--     pre-0019 status and event vocabulary until 0043 rewrites them, and VALIDATE runs in 0045 (post).
--     New writes are checked from this statement on, so an outgoing image
--     writing an old status fails closed during the rollout window.
--   * no DML and no index build on an existing table here (hot-table rule);
--     the data conversion is 0043, `payment_intents_customer_id_idx` is 0044.
CREATE TABLE "charges" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"amount" text NOT NULL,
	"amount_captured" text DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"outcome" jsonb,
	"payment_method_details" jsonb,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "charges_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "charges_payment_intent_id_key" UNIQUE("payment_intent_id"),
	CONSTRAINT "charges_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "charges_amount_captured_check" CHECK (amount_captured ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "charges_captured_within_amount_check" CHECK ("charges"."amount_captured"::numeric <= "charges"."amount"::numeric),
	CONSTRAINT "charges_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD'))
);
--> statement-breakpoint
CREATE TABLE "customer_provider_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "customer_provider_bindings_customer_provider_key" UNIQUE("customer_id","provider"),
	CONSTRAINT "customer_provider_bindings_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "customer_provider_bindings_provider_check" CHECK (provider in ('stripe'))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"email" text,
	"name" text,
	"phone" text,
	"description" text,
	"address" jsonb,
	"shipping" jsonb,
	"default_payment_method_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "customers_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "customers_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "customers_metadata_object_check" CHECK (jsonb_typeof("customers"."metadata") = 'object'),
	CONSTRAINT "customers_address_object_check" CHECK ("customers"."address" is null or jsonb_typeof("customers"."address") = 'object'),
	CONSTRAINT "customers_shipping_object_check" CHECK ("customers"."shipping" is null or jsonb_typeof("customers"."shipping") = 'object'),
	CONSTRAINT "customers_email_length_check" CHECK ("customers"."email" is null or length("customers"."email") between 1 and 512),
	CONSTRAINT "customers_deleted_has_no_default_check" CHECK ("customers"."deleted_at" is null or "customers"."default_payment_method_id" is null)
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text,
	"type" text DEFAULT 'card' NOT NULL,
	"card" jsonb NOT NULL,
	"billing_details" jsonb NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detached_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_methods_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "payment_methods_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "payment_methods_id_customer_id_key" UNIQUE("id","customer_id"),
	CONSTRAINT "payment_methods_type_check" CHECK ("payment_methods"."type" in ('card')),
	CONSTRAINT "payment_methods_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "payment_methods_metadata_object_check" CHECK (jsonb_typeof("payment_methods"."metadata") = 'object'),
	CONSTRAINT "payment_methods_detached_has_no_customer_check" CHECK ("payment_methods"."detached_at" is null or "payment_methods"."customer_id" is null)
);
--> statement-breakpoint
CREATE TABLE "setup_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"status" text DEFAULT 'requires_payment_method' NOT NULL,
	"usage" text DEFAULT 'off_session' NOT NULL,
	"client_secret" text NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_setup_error" jsonb,
	"cancellation_reason" text,
	"payment_method_id" text,
	"provider" text NOT NULL,
	"provider_object_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "setup_intents_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "setup_intents_status_check" CHECK (status in ('requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'canceled', 'succeeded')),
	CONSTRAINT "setup_intents_usage_check" CHECK (usage in ('on_session', 'off_session')),
	CONSTRAINT "setup_intents_cancellation_reason_check" CHECK (cancellation_reason is null or (status = 'canceled' and cancellation_reason in ('abandoned', 'duplicate', 'requested_by_customer'))),
	CONSTRAINT "setup_intents_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "setup_intents_metadata_object_check" CHECK (jsonb_typeof("setup_intents"."metadata") = 'object'),
	CONSTRAINT "setup_intents_succeeded_saved_a_method_check" CHECK (("setup_intents"."status" = 'succeeded') = ("setup_intents"."payment_method_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_intent_event_has_intent_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_chain_statuses_are_faircoin_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_broadcast_requires_txid_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_status_check";--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_card_statuses_are_card_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "customer_id" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "payment_method_id" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "capture_method" text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "setup_future_usage" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "receipt_email" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "statement_descriptor_suffix" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "shipping" jsonb;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "last_payment_error" jsonb;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "amount_received" text DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_provider_bindings" ADD CONSTRAINT "customer_provider_bindings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_default_payment_method_fkey" FOREIGN KEY ("default_payment_method_id","id") REFERENCES "public"."payment_methods"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_customer_merchant_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_intents" ADD CONSTRAINT "setup_intents_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_intents" ADD CONSTRAINT "setup_intents_customer_merchant_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_intents" ADD CONSTRAINT "setup_intents_payment_method_merchant_fkey" FOREIGN KEY ("payment_method_id","merchant_id") REFERENCES "public"."payment_methods"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_merchant_id_idx" ON "customers" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "customers_merchant_id_email_idx" ON "customers" USING btree ("merchant_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_provider_object_key" ON "payment_methods" USING btree ("provider","provider_object_id");--> statement-breakpoint
CREATE INDEX "payment_methods_customer_id_idx" ON "payment_methods" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "setup_intents_provider_object_key" ON "setup_intents" USING btree ("provider","provider_object_id") WHERE "setup_intents"."provider_object_id" is not null;--> statement-breakpoint
CREATE INDEX "setup_intents_merchant_id_idx" ON "setup_intents" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "setup_intents_customer_id_idx" ON "setup_intents" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_customer_merchant_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_method_merchant_fkey" FOREIGN KEY ("payment_method_id","merchant_id") REFERENCES "public"."payment_methods"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_intent_event_has_intent_check" CHECK ((type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'refund.created', 'refund.updated', 'refund.failed')) = (payment_intent_id is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_cancellation_reason_check" CHECK (cancellation_reason is null or cancellation_reason in ('abandoned', 'automatic', 'duplicate', 'fraudulent', 'requested_by_customer', 'underpaid')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_canceled_agrees_check" CHECK (("payment_intents"."status" = 'canceled') = ("payment_intents"."canceled_at" is not null) and ("payment_intents"."cancellation_reason" is null or "payment_intents"."status" = 'canceled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_capture_method_check" CHECK (capture_method in ('automatic', 'manual')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_setup_future_usage_check" CHECK (setup_future_usage is null or setup_future_usage in ('on_session', 'off_session')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_card_only_fields_check" CHECK ("payment_intents"."rail" = 'card' or ("payment_intents"."payment_method_id" is null and "payment_intents"."setup_future_usage" is null and "payment_intents"."capture_method" = 'automatic' and "payment_intents"."statement_descriptor_suffix" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_amount_received_check" CHECK (amount_received ~ '^(0|[1-9][0-9]*)$') NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_amount_received_agrees_check" CHECK (("payment_intents"."amount_received" = '0' or "payment_intents"."status" = 'succeeded') and "payment_intents"."amount_received"::numeric <= "payment_intents"."amount"::numeric) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_last_payment_error_object_check" CHECK ("payment_intents"."last_payment_error" is null or jsonb_typeof("payment_intents"."last_payment_error") = 'object') NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_shipping_object_check" CHECK ("payment_intents"."shipping" is null or jsonb_typeof("payment_intents"."shipping") = 'object') NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_processing_requires_txid_check" CHECK ("payment_intents"."rail" <> 'faircoin' or "payment_intents"."status" not in ('processing', 'succeeded') or "payment_intents"."txid" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_status_check" CHECK (status in ('requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'canceled', 'succeeded')) NOT VALID;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_card_statuses_are_card_check" CHECK (status not in ('requires_payment_method', 'requires_confirmation', 'requires_capture') or rail = 'card') NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated']::text[]) NOT VALID;
-- oxy:deploy-phase=pre
--
-- Genesis: the whole Peable schema, created from zero. Additive by
-- definition — there is nothing for it to drop, rename or narrow, so no
-- previous image is affected by any statement here.
--
-- Applied with --phase=all on a from-zero database: `pre` and `post` describe
-- the two sides of a rolling deploy, and a database created seconds ago has no
-- previous image to stay compatible with.

CREATE TABLE "checkout_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"oxy_app_id" text NOT NULL,
	"environment" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"amount" text NOT NULL,
	"network" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"success_url" text,
	"cancel_url" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "checkout_sessions_environment_check" CHECK (environment in ('development', 'staging', 'production')),
	CONSTRAINT "checkout_sessions_network_check" CHECK (network in ('mainnet', 'testnet')),
	CONSTRAINT "checkout_sessions_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "checkout_sessions_metadata_object_check" CHECK (jsonb_typeof("checkout_sessions"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"oxy_app_id" text NOT NULL,
	"environment" text NOT NULL,
	"network" text NOT NULL,
	"xpub" text NOT NULL,
	"next_derivation_index" integer DEFAULT 0 NOT NULL,
	"webhook_url" text,
	"webhook_secret" text,
	"required_confirmations" integer DEFAULT 1 NOT NULL,
	"livemode" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"avatar_file_id" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchants_id_network_key" UNIQUE("id","network"),
	CONSTRAINT "merchants_id_oxy_app_id_environment_network_key" UNIQUE("id","oxy_app_id","environment","network"),
	CONSTRAINT "merchants_environment_check" CHECK (environment in ('development', 'staging', 'production')),
	CONSTRAINT "merchants_network_check" CHECK (network in ('mainnet', 'testnet')),
	CONSTRAINT "merchants_next_derivation_index_check" CHECK ("merchants"."next_derivation_index" >= 0),
	CONSTRAINT "merchants_required_confirmations_check" CHECK ("merchants"."required_confirmations" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"status" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text DEFAULT 'FAIR' NOT NULL,
	"network" text NOT NULL,
	"address" text NOT NULL,
	"merchant_id" text NOT NULL,
	"txid" text,
	"confirmations" integer DEFAULT 0 NOT NULL,
	"client_secret" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_intents_status_check" CHECK (status in ('created', 'awaiting_approval', 'approved', 'broadcast', 'confirming', 'settled', 'expired', 'failed', 'rejected')),
	CONSTRAINT "payment_intents_currency_check" CHECK (currency in ('FAIR')),
	CONSTRAINT "payment_intents_network_check" CHECK (network in ('mainnet', 'testnet')),
	CONSTRAINT "payment_intents_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "payment_intents_confirmations_check" CHECK ("payment_intents"."confirmations" >= 0),
	CONSTRAINT "payment_intents_metadata_object_check" CHECK (jsonb_typeof("payment_intents"."metadata") = 'object'),
	CONSTRAINT "payment_intents_broadcast_requires_txid_check" CHECK ("payment_intents"."status" not in ('broadcast', 'confirming', 'settled') or "payment_intents"."txid" is not null)
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"oxy_app_id" text NOT NULL,
	"environment" text NOT NULL,
	"amount" text NOT NULL,
	"network" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"success_url" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_links_environment_check" CHECK (environment in ('development', 'staging', 'production')),
	CONSTRAINT "payment_links_network_check" CHECK (network in ('mainnet', 'testnet')),
	CONSTRAINT "payment_links_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "payment_links_metadata_object_check" CHECK (jsonb_typeof("payment_links"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "social_receive_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"network" text NOT NULL,
	"next_derivation_index" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "social_receive_cursors_network_check" CHECK (network in ('mainnet', 'testnet')),
	CONSTRAINT "social_receive_cursors_next_derivation_index_check" CHECK (next_derivation_index >= 1)
);
--> statement-breakpoint
CREATE TABLE "social_send_attributions" (
	"id" text PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"network" text NOT NULL,
	"sender_user_id" text NOT NULL,
	"recipient_user_id" text NOT NULL,
	"derivation_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "social_send_attributions_network_check" CHECK (network in ('mainnet', 'testnet')),
	CONSTRAINT "social_send_attributions_derivation_index_check" CHECK (derivation_index >= 1)
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"url" text NOT NULL,
	"attempts" integer NOT NULL,
	"delivered" boolean NOT NULL,
	"last_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "webhook_deliveries_event_type_check" CHECK (event_type in ('payment_intent.confirming', 'payment_intent.settled', 'payment_intent.failed', 'payment_intent.rejected', 'payment_intent.expired')),
	CONSTRAINT "webhook_deliveries_last_status_check" CHECK (last_status in ('delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_attempts_check" CHECK ("webhook_deliveries"."attempts" > 0),
	CONSTRAINT "webhook_deliveries_status_agrees_check" CHECK ("webhook_deliveries"."delivered" = ("webhook_deliveries"."last_status" = 'delivered'))
);
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_merchant_identity_fkey" FOREIGN KEY ("merchant_id","oxy_app_id","environment","network") REFERENCES "public"."merchants"("id","oxy_app_id","environment","network") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_merchant_id_network_fkey" FOREIGN KEY ("merchant_id","network") REFERENCES "public"."merchants"("id","network") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_merchant_identity_fkey" FOREIGN KEY ("merchant_id","oxy_app_id","environment","network") REFERENCES "public"."merchants"("id","oxy_app_id","environment","network") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_public_id_key" ON "checkout_sessions" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_payment_intent_id_key" ON "checkout_sessions" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE INDEX "checkout_sessions_oxy_app_id_environment_idx" ON "checkout_sessions" USING btree ("oxy_app_id","environment");--> statement-breakpoint
CREATE INDEX "checkout_sessions_merchant_id_idx" ON "checkout_sessions" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_public_id_key" ON "merchants" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merchants_oxy_app_id_environment_key" ON "merchants" USING btree ("oxy_app_id","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_public_id_key" ON "payment_intents" USING btree ("public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_merchant_id_idempotency_key_key" ON "payment_intents" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_intents_merchant_id_idx" ON "payment_intents" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "payment_intents_address_idx" ON "payment_intents" USING btree ("address");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_public_id_key" ON "payment_links" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "payment_links_oxy_app_id_environment_idx" ON "payment_links" USING btree ("oxy_app_id","environment");--> statement-breakpoint
CREATE INDEX "payment_links_merchant_id_idx" ON "payment_links" USING btree ("merchant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_receive_cursors_oxy_user_id_network_key" ON "social_receive_cursors" USING btree ("oxy_user_id","network");--> statement-breakpoint
CREATE UNIQUE INDEX "social_send_attributions_address_network_key" ON "social_send_attributions" USING btree ("address","network");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_merchant_id_idx" ON "webhook_deliveries" USING btree ("merchant_id");
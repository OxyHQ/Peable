-- oxy:deploy-phase=pre
-- Events and webhook endpoints (ADR 0014 D4), the EXPAND half. Additive for the
-- image still serving: new tables, a nullable webhook_deliveries.endpoint_id and
-- the recurring relay columns; the delivery CHECKs the new image no longer
-- satisfies (it writes no payload or event_type) are dropped, not narrowed.
-- HAND EDIT: the two foreign keys added to existing tables are NOT VALID (lock
-- gate rule 1); a later post migration validates them.
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"type" text NOT NULL,
	"api_version" text NOT NULL,
	"data_object" jsonb NOT NULL,
	"previous_attributes" jsonb,
	"account" text,
	"payment_intent_id" text,
	"request_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.confirming', 'payment_intent.settled', 'payment_intent.failed', 'payment_intent.rejected', 'payment_intent.expired', 'payment_intent.refunded', 'payment_intent.partially_refunded', 'payment_intent.disputed', 'payment_intent.dispute_closed', 'billing.observation.updated', 'connected_account.updated', 'webhook_endpoint.test')),
	CONSTRAINT "events_api_version_check" CHECK (api_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "events_data_object_check" CHECK (jsonb_typeof("events"."data_object") = 'object'),
	CONSTRAINT "events_previous_attributes_check" CHECK ("events"."previous_attributes" is null or jsonb_typeof("events"."previous_attributes") = 'object'),
	CONSTRAINT "events_idempotency_key_needs_request_check" CHECK ("events"."idempotency_key" is null or "events"."request_id" is not null),
	CONSTRAINT "events_intent_event_has_intent_check" CHECK ((type in ('payment_intent.confirming', 'payment_intent.settled', 'payment_intent.failed', 'payment_intent.rejected', 'payment_intent.expired', 'payment_intent.refunded', 'payment_intent.partially_refunded', 'payment_intent.disputed', 'payment_intent.dispute_closed')) = (payment_intent_id is not null))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"enabled_events" text[] NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"api_version" text NOT NULL,
	"secret" text NOT NULL,
	"previous_secret" text,
	"previous_secret_expires_at" timestamp with time zone,
	"status" text DEFAULT 'enabled' NOT NULL,
	"disabled_reason" text,
	"failing_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "webhook_endpoints_status_check" CHECK (status in ('enabled', 'disabled')),
	CONSTRAINT "webhook_endpoints_disabled_reason_check" CHECK (disabled_reason is null or disabled_reason in ('disabled_by_merchant', 'delivery_failures')),
	CONSTRAINT "webhook_endpoints_disabled_reason_agrees_check" CHECK (("webhook_endpoints"."status" = 'disabled') = ("webhook_endpoints"."disabled_reason" is not null)),
	CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.confirming', 'payment_intent.settled', 'payment_intent.failed', 'payment_intent.rejected', 'payment_intent.expired', 'payment_intent.refunded', 'payment_intent.partially_refunded', 'payment_intent.disputed', 'payment_intent.dispute_closed', 'billing.observation.updated', 'connected_account.updated']::text[]),
	CONSTRAINT "webhook_endpoints_url_check" CHECK (url ~ '^https?://' and char_length(url) <= 2048),
	CONSTRAINT "webhook_endpoints_description_check" CHECK (description is null or char_length(description) between 1 and 5000),
	CONSTRAINT "webhook_endpoints_metadata_check" CHECK (jsonb_typeof("webhook_endpoints"."metadata") = 'object'),
	CONSTRAINT "webhook_endpoints_api_version_check" CHECK (api_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "webhook_endpoints_secret_check" CHECK (char_length("webhook_endpoints"."secret") >= 1),
	CONSTRAINT "webhook_endpoints_previous_secret_agrees_check" CHECK (("webhook_endpoints"."previous_secret" is null) = ("webhook_endpoints"."previous_secret_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_type_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_payload_object_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_intent_event_has_intent_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_pending_has_envelope_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "event_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_observation_outbox" ADD COLUMN "relayed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recurring_observation_outbox" ADD COLUMN "event_id" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "endpoint_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_public_id_key" ON "events" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "events_merchant_id_id_idx" ON "events" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "events_created_at_idx" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "events_payment_intent_id_idx" ON "events" USING btree ("payment_intent_id") WHERE "events"."payment_intent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoints_public_id_key" ON "webhook_endpoints" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_merchant_id_idx" ON "webhook_endpoints" USING btree ("merchant_id");--> statement-breakpoint
ALTER TABLE "recurring_observation_outbox" ADD CONSTRAINT "recurring_observation_outbox_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "recurring_observation_outbox" ADD CONSTRAINT "recurring_observation_outbox_relayed_event_check" CHECK ("recurring_observation_outbox"."event_id" is null or "recurring_observation_outbox"."relayed_at" is not null);
-- oxy:deploy-phase=pre
CREATE TABLE "recurring_mirrors" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"oxy_app_id" text NOT NULL,
	"environment" text NOT NULL,
	"provider" text NOT NULL,
	"platform_account_id" text NOT NULL,
	"provider_account_id" text,
	"livemode" boolean NOT NULL,
	"kind" text NOT NULL,
	"object_ref" text NOT NULL,
	"binding_evidence_ref" text NOT NULL,
	"snapshot" jsonb,
	"revision" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "recurring_mirrors_object_key" UNIQUE NULLS NOT DISTINCT("provider","platform_account_id","provider_account_id","livemode","kind","object_ref"),
	CONSTRAINT "recurring_mirrors_provider_check" CHECK ("recurring_mirrors"."provider" = 'stripe'),
	CONSTRAINT "recurring_mirrors_kind_check" CHECK ("recurring_mirrors"."kind" in ('subscription', 'invoice')),
	CONSTRAINT "recurring_mirrors_mode_check" CHECK (("recurring_mirrors"."environment" = 'production') = "recurring_mirrors"."livemode"),
	CONSTRAINT "recurring_mirrors_state_check" CHECK (("recurring_mirrors"."revision" = 0 and "recurring_mirrors"."snapshot" is null and "recurring_mirrors"."observed_at" is null) or ("recurring_mirrors"."revision" > 0 and jsonb_typeof("recurring_mirrors"."snapshot") = 'object' and "recurring_mirrors"."snapshot" is not null and "recurring_mirrors"."observed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "recurring_observation_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"mirror_id" text NOT NULL,
	"revision" integer NOT NULL,
	"source_event_id" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recurring_observation_outbox_revision_key" UNIQUE("mirror_id","revision"),
	CONSTRAINT "recurring_observation_outbox_revision_check" CHECK ("recurring_observation_outbox"."revision" > 0),
	CONSTRAINT "recurring_observation_outbox_snapshot_check" CHECK (jsonb_typeof("recurring_observation_outbox"."snapshot") = 'object')
);
--> statement-breakpoint
ALTER TABLE "recurring_mirrors" ADD CONSTRAINT "recurring_mirrors_merchant_id_oxy_app_id_environment_merchants_id_oxy_app_id_environment_fk" FOREIGN KEY ("merchant_id","oxy_app_id","environment") REFERENCES "public"."merchants"("id","oxy_app_id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "recurring_observation_outbox" ADD CONSTRAINT "recurring_observation_outbox_mirror_id_recurring_mirrors_id_fk" FOREIGN KEY ("mirror_id") REFERENCES "public"."recurring_mirrors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_observation_outbox" ADD CONSTRAINT "recurring_observation_outbox_source_event_id_provider_events_id_fk" FOREIGN KEY ("source_event_id") REFERENCES "public"."provider_events"("id") ON DELETE restrict ON UPDATE no action;
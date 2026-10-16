-- oxy:deploy-phase=pre
CREATE TABLE "merchant_avatar_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"file_id" text NOT NULL,
	"action" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "merchant_avatar_audit_action_check" CHECK (action in ('cleared', 'withheld', 'released')),
	CONSTRAINT "merchant_avatar_audit_event_type_check" CHECK (event_type in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked'))
);
--> statement-breakpoint
CREATE TABLE "oxy_file_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"file_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_events_event_type_check" CHECK (event_type in ('file.deleted', 'file.visibility_changed', 'file.trashed', 'file.restored', 'file.blocked', 'file.unblocked'))
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reconciliation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"dry_run" boolean NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"finished_at" timestamp with time zone,
	"added" integer,
	"removed" integer,
	"unchanged" integer,
	"refused" integer,
	"error" text,
	CONSTRAINT "oxy_file_reconciliation_runs_entity_type_check" CHECK (entity_type in ('merchant_avatar')),
	CONSTRAINT "oxy_file_reconciliation_runs_status_check" CHECK (status in ('running', 'succeeded', 'failed', 'abandoned')),
	CONSTRAINT "oxy_file_reconciliation_runs_finished_check" CHECK (("oxy_file_reconciliation_runs"."status" = 'running') = ("oxy_file_reconciliation_runs"."finished_at" is null))
);
--> statement-breakpoint
CREATE TABLE "oxy_file_reference_syncs" (
	"file_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "oxy_file_reference_syncs_pkey" PRIMARY KEY("file_id","entity_type","entity_id"),
	CONSTRAINT "oxy_file_reference_syncs_entity_type_check" CHECK (entity_type in ('merchant_avatar')),
	CONSTRAINT "oxy_file_reference_syncs_attempts_check" CHECK ("oxy_file_reference_syncs"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "avatar_withheld" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "avatar_file_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "merchant_avatar_audit" ADD CONSTRAINT "merchant_avatar_audit_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_avatar_audit_merchant_id_idx" ON "merchant_avatar_audit" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "oxy_file_events_received_at_idx" ON "oxy_file_events" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "oxy_file_reconciliation_runs_one_running_key" ON "oxy_file_reconciliation_runs" USING btree ("entity_type") WHERE "oxy_file_reconciliation_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "oxy_file_reconciliation_runs_entity_started_idx" ON "oxy_file_reconciliation_runs" USING btree ("entity_type","started_at");--> statement-breakpoint
CREATE INDEX "oxy_file_reference_syncs_due_idx" ON "oxy_file_reference_syncs" USING btree ("next_attempt_at");--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_avatar_withheld_check" CHECK (avatar_withheld is null or avatar_withheld in ('unavailable', 'private'));--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_avatar_withheld_needs_avatar_check" CHECK ("merchants"."avatar_withheld" is null or "merchants"."avatar_file_id" is not null);
-- oxy:deploy-phase=pre
-- Orbit Phase 8: recurring report schedules. A schedule (`frs_…`) fires an
-- ordinary report run at each occurrence (`report_runs.report_schedule_id`,
-- `scheduled_for`, unique together: one run per occurrence) and its
-- recipients are owed an email in the run's completion transaction
-- (`customer_emails.report_run_id`). Constraints on the existing
-- `report_runs` and `customer_emails` go in NOT VALID; 0118 validates them.
CREATE TABLE "report_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"report_type" text NOT NULL,
	"columns" text[],
	"currency" text,
	"interval" text NOT NULL,
	"weekly_anchor" text,
	"monthly_anchor" integer,
	"timezone" text NOT NULL,
	"recipients" text[] DEFAULT '{}'::text[] NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "report_schedules_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "report_schedules_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "report_schedules_report_type_check" CHECK (report_type in ('payments.itemized.1', 'balance.summary.1', 'balance_transactions.itemized.1', 'payouts.itemized.1', 'refunds.itemized.1', 'disputes.itemized.1')),
	CONSTRAINT "report_schedules_currency_check" CHECK (currency is null or currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "report_schedules_columns_check" CHECK ("report_schedules"."columns" is null or cardinality("report_schedules"."columns") >= 1),
	CONSTRAINT "report_schedules_interval_check" CHECK (interval in ('daily', 'weekly', 'monthly')),
	CONSTRAINT "report_schedules_anchor_check" CHECK ((interval = 'weekly') = (weekly_anchor is not null) and (interval = 'monthly') = (monthly_anchor is not null) and (weekly_anchor is null or weekly_anchor in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')) and (monthly_anchor is null or monthly_anchor between 1 and 31)),
	CONSTRAINT "report_schedules_timezone_check" CHECK (length("report_schedules"."timezone") between 1 and 64),
	CONSTRAINT "report_schedules_recipients_check" CHECK (cardinality(recipients) <= 10),
	CONSTRAINT "report_schedules_locale_check" CHECK (locale in ('en', 'es')),
	CONSTRAINT "report_schedules_status_check" CHECK (status in ('active', 'paused', 'canceled')),
	CONSTRAINT "report_schedules_next_run_agrees_check" CHECK (("report_schedules"."status" = 'active') = ("report_schedules"."next_run_at" is not null)),
	CONSTRAINT "report_schedules_canceled_agrees_check" CHECK (("report_schedules"."status" = 'canceled') = ("report_schedules"."canceled_at" is not null)),
	CONSTRAINT "report_schedules_lease_agrees_check" CHECK (("report_schedules"."lease_token" is null) = ("report_schedules"."lease_expires_at" is null) and ("report_schedules"."status" = 'active' or "report_schedules"."lease_token" is null))
);
--> statement-breakpoint
ALTER TABLE "customer_emails" DROP CONSTRAINT "customer_emails_kind_check";--> statement-breakpoint
ALTER TABLE "customer_emails" DROP CONSTRAINT "customer_emails_subject_check";--> statement-breakpoint
ALTER TABLE "customer_emails" ADD COLUMN "report_run_id" text;--> statement-breakpoint
ALTER TABLE "report_runs" ADD COLUMN "report_schedule_id" text;--> statement-breakpoint
ALTER TABLE "report_runs" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report_schedules" ADD CONSTRAINT "report_schedules_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_schedules_merchant_id_id_idx" ON "report_schedules" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "report_schedules_due_idx" ON "report_schedules" USING btree ("next_run_at") WHERE "report_schedules"."status" = 'active';--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_report_run_fkey" FOREIGN KEY ("report_run_id") REFERENCES "public"."report_runs"("id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_report_schedule_fkey" FOREIGN KEY ("report_schedule_id","merchant_id") REFERENCES "public"."report_schedules"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
CREATE UNIQUE INDEX "report_runs_schedule_occurrence_key" ON "report_runs" USING btree ("report_schedule_id","scheduled_for");--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_kind_check" CHECK (kind in ('payment_receipt', 'refund_notice', 'checkout_confirmation', 'invoice', 'invoice_payment_failed', 'report_run_succeeded', 'report_run_failed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_subject_check" CHECK (("customer_emails"."kind" = 'payment_receipt' and "customer_emails"."payment_intent_id" is not null and "customer_emails"."receipt_number" is not null)
        or ("customer_emails"."kind" = 'refund_notice' and "customer_emails"."refund_id" is not null)
        or ("customer_emails"."kind" = 'checkout_confirmation' and "customer_emails"."checkout_session_id" is not null)
        or ("customer_emails"."kind" in ('invoice', 'invoice_payment_failed') and "customer_emails"."invoice_id" is not null)
        or ("customer_emails"."kind" in ('report_run_succeeded', 'report_run_failed') and "customer_emails"."report_run_id" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_schedule_agrees_check" CHECK (("report_runs"."report_schedule_id" is null) = ("report_runs"."scheduled_for" is null)) NOT VALID;

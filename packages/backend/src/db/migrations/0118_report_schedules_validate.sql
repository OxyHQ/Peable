-- oxy:deploy-phase=post
-- Validates what 0117 added NOT VALID to the existing `report_runs` and
-- `customer_emails`. VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and
-- writes continue while it scans.
ALTER TABLE "report_runs" VALIDATE CONSTRAINT "report_runs_report_schedule_fkey";--> statement-breakpoint
ALTER TABLE "report_runs" VALIDATE CONSTRAINT "report_runs_schedule_agrees_check";--> statement-breakpoint
ALTER TABLE "customer_emails" VALIDATE CONSTRAINT "customer_emails_report_run_fkey";--> statement-breakpoint
ALTER TABLE "customer_emails" VALIDATE CONSTRAINT "customer_emails_kind_check";--> statement-breakpoint
ALTER TABLE "customer_emails" VALIDATE CONSTRAINT "customer_emails_subject_check";

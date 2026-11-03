-- oxy:deploy-phase=pre
-- Report downloads and the itemized balance transaction, refund and dispute reports:
-- `report_runs.report_type` takes the three new layouts. HAND EDIT: the widened
-- CHECK is re-added `NOT VALID` (ACCESS EXCLUSIVE without a scan); 0068 (post)
-- validates it.
ALTER TABLE "report_runs" DROP CONSTRAINT "report_runs_report_type_check";--> statement-breakpoint
ALTER TABLE "report_runs" ADD CONSTRAINT "report_runs_report_type_check" CHECK (report_type in ('payments.itemized.1', 'balance.summary.1', 'balance_transactions.itemized.1', 'payouts.itemized.1', 'refunds.itemized.1', 'disputes.itemized.1')) NOT VALID;

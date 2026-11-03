-- oxy:deploy-phase=post
-- Validates the widened `report_runs_report_type_check` of 0067 once the outgoing
-- image (which never writes the new report types) is gone. SHARE UPDATE EXCLUSIVE:
-- reads and writes continue while it scans.
ALTER TABLE "report_runs" VALIDATE CONSTRAINT "report_runs_report_type_check";

-- oxy:deploy-phase=pre
-- Nullable metadata-only addition; no backfill, no financial mutation.
ALTER TABLE "invoices" ADD COLUMN "accepted_finalization_revision" text;
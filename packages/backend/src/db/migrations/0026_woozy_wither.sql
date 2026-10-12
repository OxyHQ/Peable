-- oxy:deploy-phase=pre
ALTER TABLE "billing_operations" ADD COLUMN "initial_invoice_ref" text;

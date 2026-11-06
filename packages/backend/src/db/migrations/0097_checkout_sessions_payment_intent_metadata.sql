-- oxy:deploy-phase=pre
-- ADR 0021 D8: `payment_intent_data.metadata`, copied to every payment a session
-- creates. Hot table, this DDL alone: a nullable column with no default is
-- metadata-only, no rewrite.
ALTER TABLE "checkout_sessions" ADD COLUMN "payment_intent_metadata" jsonb;

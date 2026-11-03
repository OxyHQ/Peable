-- oxy:deploy-phase=pre
-- ADR 0015 §2 — `merchants.first_party`, alone (hot table). A constant default:
-- catalog-only on PostgreSQL 11+, no rewrite.
ALTER TABLE "merchants" ADD COLUMN "first_party" boolean DEFAULT false NOT NULL;

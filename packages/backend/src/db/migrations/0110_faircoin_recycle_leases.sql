-- oxy:deploy-phase=pre
-- ADR 0021 D9 (amended 2026-11-06): concurrent confirms recycle too. A confirm
-- LEASES the candidate it checks against the chain (`recycle_lease_until`), so
-- overlapping confirms check different ones, and a check that finds it unused
-- is stamped (`recycle_checked_at`), so a reservation whose candidate was taken
-- claims another one under the pool's lock without an HTTP call.
-- payment_intent_outputs is not a hot table; nullable columns, no defaults
-- (catalog only). The running image writes neither and reads neither.
ALTER TABLE "payment_intent_outputs" ADD COLUMN "recycle_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" ADD COLUMN "recycle_lease_until" timestamp with time zone;
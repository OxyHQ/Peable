-- oxy:deploy-phase=pre
-- Risk rules (ADR 0022), part 2 of 5: every charge that exists when this runs
-- is marked judged (`radar_evaluated_at = coalesce(synced_at, created_at)`), so
-- a rule written later never judges a payment authorized before rules existed.
-- Alone: a row update on `charges` (not a hot table) takes ROW EXCLUSIVE and
-- row locks only, so reads continue and no other table is locked while it
-- runs. The old image serving meanwhile never reads or writes the column.
UPDATE "charges" SET "radar_evaluated_at" = coalesce("synced_at", "created_at") WHERE "radar_evaluated_at" IS NULL;

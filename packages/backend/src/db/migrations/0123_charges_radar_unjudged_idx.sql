-- oxy:deploy-phase=pre
-- Risk rules (ADR 0022), part 3 of 5: the judge sweep's queue — a partial
-- index over the unjudged charges, empty after 0122. Alone and IF NOT EXISTS:
-- build it CONCURRENTLY out of band first and this is a no-op over it.
CREATE INDEX IF NOT EXISTS "charges_radar_unjudged_idx" ON "charges" USING btree ("radar_judge_attempted_at","created_at") WHERE "charges"."radar_evaluated_at" is null;

-- oxy:deploy-phase=pre
-- Backfill `provider_events.received_seq` for the rows stored before 0069, in the
-- best order those rows can still tell: `created_at`, then `id`.
--
-- NEGATIVE, from -N to -1, and that is the point. Rows inserted since 0069 already
-- hold 1, 2, … from the sequence (the running image does not name the column, so
-- the default numbers its inserts), and every pre-0069 row arrived before all of
-- them. Drawing these from `nextval` instead would number the oldest rows AFTER
-- the newest. Idempotent: only rows still NULL are touched.
--
-- No lock beyond the rows it writes: no DDL in this file (0069 holds the column).
UPDATE "provider_events" AS "event"
SET "received_seq" = "ordered"."seq"
FROM (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id") - count(*) OVER () - 1 AS "seq"
	FROM "provider_events"
	WHERE "received_seq" IS NULL
) AS "ordered"
WHERE "event"."id" = "ordered"."id";

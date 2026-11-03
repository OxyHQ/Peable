-- oxy:deploy-phase=pre
-- Every provider event carries its arrival order from here on. Hot-table DDL, alone,
-- and AFTER the 0070 backfill: a NOT VALID CHECK is still enforced on every row an
-- UPDATE writes, so added before the backfill it would have refused the running
-- drain's `processed_at` write on any pre-0069 row still NULL.
-- HAND EDIT: `NOT VALID` (ACCESS EXCLUSIVE without a scan); 0072 (post) validates it,
-- sets NOT NULL over it without a scan, and drops it.
ALTER TABLE "provider_events" ADD CONSTRAINT "provider_events_received_seq_not_null_check" CHECK ("provider_events"."received_seq" is not null) NOT VALID;

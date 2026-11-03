-- oxy:deploy-phase=post
-- `provider_events.received_seq` becomes NOT NULL, without a scan under ACCESS EXCLUSIVE.
-- HAND EDIT: drizzle-kit generated only the DROP and the SET NOT NULL, in that order,
-- which would make SET NOT NULL scan the hot table under ACCESS EXCLUSIVE. Instead:
-- VALIDATE first (SHARE UPDATE EXCLUSIVE: reads and writes continue while it scans),
-- then SET NOT NULL, which a validated `IS NOT NULL` CHECK lets skip its own scan,
-- then the CHECK is dropped because the column now says the same thing.
ALTER TABLE "provider_events" VALIDATE CONSTRAINT "provider_events_received_seq_not_null_check";--> statement-breakpoint
ALTER TABLE "provider_events" ALTER COLUMN "received_seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_events" DROP CONSTRAINT "provider_events_received_seq_not_null_check";

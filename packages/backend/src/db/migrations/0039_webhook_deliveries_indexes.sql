-- oxy:deploy-phase=pre
-- The cascade paths into webhook_deliveries: an event swept after 30 days and a
-- deleted webhook endpoint each delete their deliveries through these.
-- HAND EDIT: IF NOT EXISTS (lock gate rule 3) — on a large table build them
-- CONCURRENTLY out of band first and this migration is a no-op over them.
-- Kept apart from 0038 because that one takes ACCESS EXCLUSIVE on the table.
CREATE INDEX IF NOT EXISTS "webhook_deliveries_event_id_idx" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_endpoint_id_idx" ON "webhook_deliveries" USING btree ("endpoint_id");

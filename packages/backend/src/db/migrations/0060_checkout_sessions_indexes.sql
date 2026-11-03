-- oxy:deploy-phase=pre
-- Orbit Phase 3: the four new indexes of checkout_sessions (setup intent, the
-- open-session expiry claim, payment link, a link visit's operation key). On a hot table, so IF NOT EXISTS
-- (hand edit): build them CONCURRENTLY out of band first and this is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_sessions_setup_intent_id_key" ON "checkout_sessions" USING btree ("setup_intent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkout_sessions_open_expires_at_idx" ON "checkout_sessions" USING btree ("expires_at") WHERE "checkout_sessions"."status" = 'open';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checkout_sessions_payment_link_id_idx" ON "checkout_sessions" USING btree ("payment_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_sessions_link_operation_key" ON "checkout_sessions" USING btree ("payment_link_id","link_operation_key");
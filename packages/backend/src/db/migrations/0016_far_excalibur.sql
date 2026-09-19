-- oxy:deploy-phase=pre
-- A merchant-facing event that is not about a payment.
--
-- `webhook_deliveries.payment_intent_id` was NOT NULL, so
-- `connected_account.updated` could not be enqueued at all — which is why the
-- account handler refreshed the local row and told the merchant nothing. A
-- seller finished onboarding and the marketplace could only learn it by polling
-- `GET /v1/connected_accounts` or by attempting a settlement and reading the
-- refusal. Naming an unrelated payment to satisfy the constraint was the other
-- option and is worse than the gap: a delivery pointing at a payment the event
-- is not about is one a merchant correlates wrongly.
--
-- The new CHECK is what stops the widening from also admitting a
-- `payment_intent.settled` with no intent — a delivery nobody can correlate to
-- anything. It keys on the `payment_intent.` prefix rather than on a list, so a
-- new payment event inherits the rule without an edit here.
--
-- `pre`, and safe under the old image: dropping NOT NULL widens what is
-- accepted, the old image writes the column on every enqueue, and the CHECK is
-- satisfied by every row it can produce (it only ever writes
-- `payment_intent.*` events, always with an intent).
--
-- ## Why each CHECK is added `NOT VALID` and validated separately
--
-- `ADD CONSTRAINT … CHECK` takes ACCESS EXCLUSIVE on the table and holds it for
-- a full sequential scan. `webhook_deliveries` is the one UNBOUNDED table in
-- this schema — a row per delivery, kept as the log a merchant consults to find
-- out whether they were told something — so that scan grows with the lifetime
-- of the deployment while every enqueue blocks behind it. An enqueue blocks
-- inside the transaction advancing a payment's status (ADR 0001 D7), so the
-- lock is not held against a webhook, it is held against settlements.
--
-- `NOT VALID` takes the same lock for a catalogue write and nothing else; the
-- constraint is enforced on every new row immediately. `VALIDATE CONSTRAINT`
-- then scans under SHARE UPDATE EXCLUSIVE, which does not block reads or
-- writes — the same total work, off the critical path.
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_type_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "payment_intent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_intent_event_has_intent_check" CHECK (("webhook_deliveries"."event_type" like 'payment_intent.%') = ("webhook_deliveries"."payment_intent_id" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" VALIDATE CONSTRAINT "webhook_deliveries_intent_event_has_intent_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_type_check" CHECK (event_type in ('payment_intent.confirming', 'payment_intent.settled', 'payment_intent.failed', 'payment_intent.rejected', 'payment_intent.expired', 'payment_intent.refunded', 'payment_intent.partially_refunded', 'payment_intent.disputed', 'payment_intent.dispute_closed', 'connected_account.updated')) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" VALIDATE CONSTRAINT "webhook_deliveries_event_type_check";
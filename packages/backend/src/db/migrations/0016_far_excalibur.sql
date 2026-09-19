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
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_event_type_check";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "payment_intent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_intent_event_has_intent_check" CHECK (("webhook_deliveries"."event_type" like 'payment_intent.%') = ("webhook_deliveries"."payment_intent_id" is not null));--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_type_check" CHECK (event_type in ('payment_intent.confirming', 'payment_intent.settled', 'payment_intent.failed', 'payment_intent.rejected', 'payment_intent.expired', 'payment_intent.refunded', 'payment_intent.partially_refunded', 'payment_intent.disputed', 'payment_intent.dispute_closed', 'connected_account.updated'));
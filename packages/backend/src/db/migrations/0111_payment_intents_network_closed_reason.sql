-- oxy:deploy-phase=pre
-- ADR 0002's gate, closed again: an open mainnet FairCoin payment nobody has
-- broadcast to is cancelled `faircoin_network_closed` while the deployment says
-- testnet, and its order stays open. Hot table: this DDL alone; the widened
-- CHECK is NOT VALID (added by hand), so the ACCESS EXCLUSIVE lock never scans.
-- 0112 (post) validates it. The running image never writes the new value.
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_cancellation_reason_check";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_cancellation_reason_check" CHECK (cancellation_reason is null or cancellation_reason in ('abandoned', 'automatic', 'duplicate', 'faircoin_network_closed', 'fraudulent', 'recipient_key_changed', 'requested_by_customer', 'underpaid')) NOT VALID;

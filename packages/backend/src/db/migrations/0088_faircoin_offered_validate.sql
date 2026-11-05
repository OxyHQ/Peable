-- oxy:deploy-phase=post
-- Validates the CHECKs 0085–0087 added NOT VALID. VALIDATE takes SHARE UPDATE
-- EXCLUSIVE, so reads and writes continue while it scans.
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_faircoin_quote_check";--> statement-breakpoint
ALTER TABLE "balance_transactions" VALIDATE CONSTRAINT "balance_transactions_faircoin_quote_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_connected_account_has_network_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_faircoin_rail_has_network_check";

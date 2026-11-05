-- oxy:deploy-phase=post
-- Validates what 0089–0093 added NOT VALID. VALIDATE takes SHARE UPDATE
-- EXCLUSIVE, so reads and writes continue while it scans.
ALTER TABLE "merchants" VALIDATE CONSTRAINT "merchants_owner_account_id_check";--> statement-breakpoint
ALTER TABLE "merchants" VALIDATE CONSTRAINT "merchants_network_present_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_faircoin_recipient_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" VALIDATE CONSTRAINT "connected_accounts_faircoin_fields_agree_check";

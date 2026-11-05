-- oxy:deploy-phase=pre
-- ADR 0021 D5: the account whose Peable wallet a FairCoin payment pays. Hot
-- table: this DDL alone, nullable, no default; CHECK NOT VALID, 0094 validates.
ALTER TABLE "payment_intents" ADD COLUMN "faircoin_recipient_account_id" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_faircoin_recipient_check" CHECK ("payment_intents"."faircoin_recipient_account_id" is null or "payment_intents"."rail" = 'faircoin') NOT VALID;

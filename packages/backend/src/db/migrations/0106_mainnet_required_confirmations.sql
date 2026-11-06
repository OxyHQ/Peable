-- oxy:deploy-phase=post
-- ADR 0021 D10: a mainnet merchant settles a FairCoin payment at 6 confirmations
-- by default (FairCoin's own coinbase maturity, ~12 minutes of 2-minute blocks),
-- not 1. `required_confirmations` defaulted to 1 for every merchant and the
-- value cannot tell a choice from the default, so a mainnet merchant still at 1
-- is raised; a merchant that chose any other value keeps it, and one that wants
-- 1 back sets it with `POST /v1/merchants/me`. A handful of rows on the hot
-- merchants table, one statement, no DDL.
-- Then validates the CHECK 0105 added NOT VALID (SHARE UPDATE EXCLUSIVE on the
-- outputs: reads and writes continue).
UPDATE "merchants" SET "required_confirmations" = 6
WHERE "network" = 'mainnet' AND "required_confirmations" = 1;--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" VALIDATE CONSTRAINT "payment_intent_outputs_derivation_index_check";

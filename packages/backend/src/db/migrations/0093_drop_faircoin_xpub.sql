-- oxy:deploy-phase=post
-- ADR 0021 D5 (amended 2026-11-06): the watch-only xpub mechanism is removed —
-- FairCoin goes to the owning account's Peable wallet. Post: the previous image
-- still reads these columns until it is drained. The keys dropped belong to the
-- three "ctf" test merchants and one test seller (read-only production read,
-- 2026-11-05); their past payments keep their addresses and still settle.
ALTER TABLE "connected_accounts" DROP CONSTRAINT "connected_accounts_next_derivation_index_check";--> statement-breakpoint
ALTER TABLE "merchants" DROP CONSTRAINT "merchants_next_derivation_index_check";--> statement-breakpoint
DROP INDEX "connected_accounts_xpub_key";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "xpub";--> statement-breakpoint
ALTER TABLE "connected_accounts" DROP COLUMN "next_derivation_index";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "xpub";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "next_derivation_index";--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_network_present_check" CHECK ("merchants"."network" is not null) NOT VALID;

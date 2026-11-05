-- oxy:deploy-phase=pre
-- ADR 0021 D5 (amended): FairCoin is received into the Peable wallet of the
-- account that owns the merchant. The merchant mirrors that owner; a network no
-- longer needs a key beside it (the xpub mechanism is removed, its columns are
-- dropped by 0093 once no image reads them). CHECK NOT VALID; 0094 validates.
ALTER TABLE "merchants" DROP CONSTRAINT "merchants_chain_fields_agree_check";--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "owner_account_id" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_owner_account_id_check" CHECK ("merchants"."owner_account_id" is null or length("merchants"."owner_account_id") > 0) NOT VALID;

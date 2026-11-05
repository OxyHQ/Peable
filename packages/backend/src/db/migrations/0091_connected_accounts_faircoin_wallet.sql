-- oxy:deploy-phase=pre
-- ADR 0021 D5: a seller's FairCoin half is confirmed by the seller and paid
-- into their own Peable wallet; it no longer carries a key, so the
-- confirmation time no longer pairs with an xpub. Every existing row satisfies
-- the narrower rule. NOT VALID; 0094 validates.
ALTER TABLE "connected_accounts" DROP CONSTRAINT "connected_accounts_faircoin_fields_agree_check";--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_faircoin_fields_agree_check" CHECK (("connected_accounts"."network" is null) = ("connected_accounts"."faircoin_oxy_user_id" is null)
          and ("connected_accounts"."faircoin_registered_at" is null or "connected_accounts"."network" is not null)) NOT VALID;

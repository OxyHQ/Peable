-- oxy:deploy-phase=pre
-- A merchant can take CARDS without registering a FairCoin account.
--
-- `POST /v1/merchants` required `network` and `xpub` unconditionally, so a
-- merchant who only wanted card payments had to supply a watch-only extended
-- key for a chain they had no intention of using. Whatever they supplied was
-- then either a real key they now had to custody, or a fixture that silently
-- made their FairCoin receive addresses underivable by their own wallet.
--
-- The two columns are two halves of ONE capability, so they become nullable
-- together and `merchants_chain_fields_agree_check` refuses a half-configured
-- merchant: a network with no key derives nothing, and a key with no network
-- cannot be interpreted at all, since an extended key's version bytes are
-- network-specific.
--
-- `pre`, and safe under the old image: dropping NOT NULL widens what is
-- accepted, the old image keeps writing both columns on every registration, and
-- the agreement CHECK is satisfied by every row it can produce.
ALTER TABLE "merchants" DROP CONSTRAINT "merchants_network_check";--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "network" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ALTER COLUMN "xpub" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_chain_fields_agree_check" CHECK (("merchants"."network" is null) = ("merchants"."xpub" is null));--> statement-breakpoint
ALTER TABLE "merchants" ADD CONSTRAINT "merchants_network_check" CHECK (network is null or network in ('mainnet', 'testnet'));
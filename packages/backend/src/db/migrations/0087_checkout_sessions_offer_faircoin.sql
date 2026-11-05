-- oxy:deploy-phase=pre
-- ADR 0021 D1/D5: FairCoin is offered on every order, so a fiat session carries
-- the payee's network too, and a fiat session may name a seller (paid by its
-- FairCoin choice). The two old CHECKs (network ⇔ FairCoin rail, seller ⇒
-- FairCoin rail) are replaced by what still holds: a FAIR order has a network,
-- and a seller's session has one. Every row the old image writes satisfies
-- both, so this runs before the new image. NOT VALID; 0088 validates.
ALTER TABLE "checkout_sessions" DROP CONSTRAINT "checkout_sessions_connected_account_is_faircoin_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" DROP CONSTRAINT "checkout_sessions_rail_network_agrees_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_connected_account_has_network_check" CHECK ("checkout_sessions"."connected_account_id" is null or "checkout_sessions"."network" is not null) NOT VALID;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_faircoin_rail_has_network_check" CHECK ("checkout_sessions"."rail" <> 'faircoin' or "checkout_sessions"."network" is not null) NOT VALID;

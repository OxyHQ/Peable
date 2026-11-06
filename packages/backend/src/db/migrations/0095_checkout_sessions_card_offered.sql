-- oxy:deploy-phase=pre
-- ADR 0021 D1: a fiat order may be FairCoin-only (the merchant turned its card
-- methods off for it; FairCoin can never be). Hot table, this DDL alone; a
-- constant default is metadata-only, so no rewrite. Every existing row offered
-- the card, which is the default.
ALTER TABLE "checkout_sessions" ADD COLUMN "card_offered" boolean DEFAULT true NOT NULL;

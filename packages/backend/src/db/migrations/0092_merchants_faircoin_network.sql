-- oxy:deploy-phase=pre
-- ADR 0021 D5: every merchant has a FairCoin network — its environment's —
-- because every order offers FairCoin. Rows that chose one keep it (payments
-- reference it). Data only, on its own (merchants is hot).
UPDATE "merchants" SET "network" = CASE WHEN "environment" = 'production' THEN 'mainnet' ELSE 'testnet' END WHERE "network" IS NULL;

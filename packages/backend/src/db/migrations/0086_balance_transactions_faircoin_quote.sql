-- oxy:deploy-phase=pre
-- ADR 0021 D7: the informational FairCoin entry of a quoted payment carries
-- the quote, its fiat equivalent. Additive and nullable; CHECK NOT VALID,
-- validated by 0088.
ALTER TABLE "balance_transactions" ADD COLUMN "faircoin_quote" jsonb;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_faircoin_quote_check" CHECK ("balance_transactions"."faircoin_quote" is null or ("balance_transactions"."status" = 'informational' and jsonb_typeof("balance_transactions"."faircoin_quote") = 'object')) NOT VALID;

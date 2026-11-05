-- oxy:deploy-phase=pre
-- ADR 0021 D4: a FairCoin payment of a fiat order carries the quote it was
-- priced at. Additive and nullable (no default, no rewrite); the CHECK is
-- added NOT VALID so it does not scan this hot table under ACCESS EXCLUSIVE —
-- 0088 validates it. The old image never writes the column.
ALTER TABLE "payment_intents" ADD COLUMN "faircoin_quote" jsonb;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_faircoin_quote_check" CHECK ("payment_intents"."faircoin_quote" is null or ("payment_intents"."rail" = 'faircoin' and jsonb_typeof("payment_intents"."faircoin_quote") = 'object')) NOT VALID;

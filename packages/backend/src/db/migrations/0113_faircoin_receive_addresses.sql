-- oxy:deploy-phase=pre
-- ADR 0021 D9 (amended 2026-11-06): the recipient's wallet watches exactly the
-- addresses the gateway handed out, synced in index order from
-- `payment_intent_outputs` and `social_send_attributions`
-- (`GET /v1/social/me/receive_addresses`), and each recipient's unpaid
-- addresses of the last day are bounded. Indexes for both reads; neither table
-- is hot (`db:check-locks`), both are small, and the running image reads none.
CREATE INDEX "payment_intent_outputs_recipient_index_idx" ON "payment_intent_outputs" USING btree ("recipient_account_id","network","derivation_index");--> statement-breakpoint
CREATE INDEX "payment_intent_outputs_recipient_created_idx" ON "payment_intent_outputs" USING btree ("recipient_account_id","network","created_at");--> statement-breakpoint
CREATE INDEX "social_send_attributions_recipient_index_idx" ON "social_send_attributions" USING btree ("recipient_user_id","network","derivation_index");--> statement-breakpoint
CREATE INDEX "social_send_attributions_recipient_created_idx" ON "social_send_attributions" USING btree ("recipient_user_id","network","created_at");--> statement-breakpoint
-- The sync cursor is the derivation index, so a new address must always get an
-- index above every one already recorded for its recipient. Attributions
-- written before migration 0009 deleted the keyless cursors can sit above the
-- cursor that replaced them (testnet only: mainnet never minted): move each
-- such cursor past them. Skipping indices is harmless; a few rows.
UPDATE "social_receive_cursors" AS "c"
SET "next_derivation_index" = "m"."next_index"
FROM (
  SELECT "account_id", "network", max("derivation_index") + 1 AS "next_index"
  FROM (
    SELECT "recipient_user_id" AS "account_id", "network", "derivation_index" FROM "social_send_attributions"
    UNION ALL
    SELECT "recipient_account_id", "network", "derivation_index" FROM "payment_intent_outputs" WHERE "derivation_index" IS NOT NULL
  ) AS "recorded"
  GROUP BY "account_id", "network"
) AS "m"
WHERE "c"."oxy_user_id" = "m"."account_id"
  AND "c"."network" = "m"."network"
  AND "c"."next_derivation_index" < "m"."next_index";
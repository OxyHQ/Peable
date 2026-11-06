-- oxy:deploy-phase=post
-- ADR 0021 D9 (amended 2026-11-06): addresses are never recycled. The pool's
-- columns go and an address belongs to ONE output for ever: the unique index
-- is no longer partial on `recycled_at`. Post: the previous image still reads
-- and writes those columns until it has drained. Nothing was ever recycled on
-- testnet (its Explorer answers `unknown`, and `unknown` never recycles) and
-- mainnet never opened, so no address has two outputs; the block below refuses
-- with a readable message rather than fail inside the CREATE if one does.
-- payment_intent_outputs is not a hot table and is small.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "payment_intent_outputs" GROUP BY "network", "address" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'payment_intent_outputs holds a recycled address (two outputs share (network, address)); resolve before 0114 (ADR 0021 D9)';
  END IF;
END $$;--> statement-breakpoint
DROP INDEX "payment_intent_outputs_recipient_pool_idx";--> statement-breakpoint
DROP INDEX "payment_intent_outputs_network_address_key";--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intent_outputs_network_address_key" ON "payment_intent_outputs" USING btree ("network","address");--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" DROP COLUMN "recycled_at";--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" DROP COLUMN "retired_at";--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" DROP COLUMN "recycle_checked_at";--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" DROP COLUMN "recycle_lease_until";
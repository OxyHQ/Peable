-- oxy:deploy-phase=pre
-- ADR 0002 (amended 2026-11-06): each FairCoin output and each social send
-- attribution records the identity key its address was derived from. Nullable,
-- no default (rows written before keep NULL); CHECKs NOT VALID on these
-- existing tables, validated in 0101 (post).
ALTER TABLE "payment_intent_outputs" ADD COLUMN "identity_public_key" text;--> statement-breakpoint
ALTER TABLE "social_send_attributions" ADD COLUMN "identity_public_key" text;--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" ADD CONSTRAINT "payment_intent_outputs_identity_key_check" CHECK (identity_public_key is null or identity_public_key ~ '^(0[23][0-9a-f]{64}|04[0-9a-f]{128})$') NOT VALID;--> statement-breakpoint
ALTER TABLE "social_send_attributions" ADD CONSTRAINT "social_send_attributions_identity_key_check" CHECK (identity_public_key is null or identity_public_key ~ '^(0[23][0-9a-f]{64}|04[0-9a-f]{128})$') NOT VALID;

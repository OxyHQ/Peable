-- oxy:deploy-phase=post
-- Validates what 0099 and 0100 added NOT VALID. VALIDATE takes SHARE UPDATE
-- EXCLUSIVE, so reads and writes continue while it scans.
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_faircoin_identity_key_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_faircoin_key_replaced_check";--> statement-breakpoint
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_cancellation_reason_check";--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" VALIDATE CONSTRAINT "payment_intent_outputs_identity_key_check";--> statement-breakpoint
ALTER TABLE "social_send_attributions" VALIDATE CONSTRAINT "social_send_attributions_identity_key_check";

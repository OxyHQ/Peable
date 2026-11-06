-- oxy:deploy-phase=post
-- Validates the cancellation reasons 0111 widened NOT VALID. VALIDATE takes
-- SHARE UPDATE EXCLUSIVE, so reads and writes continue while it scans.
ALTER TABLE "payment_intents" VALIDATE CONSTRAINT "payment_intents_cancellation_reason_check";

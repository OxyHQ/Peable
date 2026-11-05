-- oxy:deploy-phase=post
-- Validates the `webhook_endpoints_disabled_reason_check` 0083 re-added NOT
-- VALID. VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes continue.
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_disabled_reason_check";

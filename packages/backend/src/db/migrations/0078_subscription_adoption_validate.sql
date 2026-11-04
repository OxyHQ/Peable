-- oxy:deploy-phase=post
-- Adopting a provider-billed subscription (ADR 0018 §7), part 2 of 2
-- (hand-written): VALIDATE the CHECK 0077 added NOT VALID. VALIDATE takes
-- SHARE UPDATE EXCLUSIVE, so reads and writes continue.
ALTER TABLE "subscriptions" VALIDATE CONSTRAINT "subscriptions_provider_handoff_check";

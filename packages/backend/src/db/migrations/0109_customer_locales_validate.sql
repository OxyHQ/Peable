-- oxy:deploy-phase=post
-- Validates the locale CHECKs 0107 and 0108 added NOT VALID. VALIDATE takes
-- SHARE UPDATE EXCLUSIVE, so reads and writes continue while it scans.
ALTER TABLE "customers" VALIDATE CONSTRAINT "customers_preferred_locales_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_payer_locale_check";

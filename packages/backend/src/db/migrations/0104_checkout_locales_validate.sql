-- oxy:deploy-phase=post
-- Validates the widened locale CHECKs 0102 and 0103 added NOT VALID. VALIDATE
-- takes SHARE UPDATE EXCLUSIVE, so reads and writes continue while it scans.
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_locale_check";--> statement-breakpoint
ALTER TABLE "payment_links" VALIDATE CONSTRAINT "payment_links_options_check";

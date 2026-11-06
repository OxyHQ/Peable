-- oxy:deploy-phase=pre
-- The payer locale set widens to the Pay with Peable sheet's fifteen languages
-- (`CHECKOUT_LOCALES`: ar, bn, ca, de, en, es, fr, hi, id, it, ja, pt, ru, tr,
-- zh). Hot table, so this file holds only its own DDL. HAND EDIT: the widened
-- CHECK is added NOT VALID (no scan under the ACCESS EXCLUSIVE lock; it is still
-- enforced on every write) and 0104 (post) validates it. Every existing value is
-- in the new set, so validation cannot fail.
ALTER TABLE "checkout_sessions" DROP CONSTRAINT "checkout_sessions_locale_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_locale_check" CHECK (locale is null or locale in ('ar', 'bn', 'ca', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'pt', 'ru', 'tr', 'zh')) NOT VALID;

-- oxy:deploy-phase=pre
-- The language the payer confirmed a checkout in (`…/public/confirm`'s
-- `locale`), internal to the session. Hot table, so this file holds only its
-- own DDL: a nullable column with no default is catalog-only. HAND EDIT: the
-- CHECK is added NOT VALID and 0109 (post) validates it; every existing row is
-- NULL, so validation cannot fail.
ALTER TABLE "checkout_sessions" ADD COLUMN "payer_locale" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_payer_locale_check" CHECK (payer_locale is null or payer_locale in ('ar', 'bn', 'ca', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'pt', 'ru', 'tr', 'zh')) NOT VALID;

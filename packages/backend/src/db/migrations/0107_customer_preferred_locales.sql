-- oxy:deploy-phase=pre
-- A customer's preferred languages (Stripe's `preferred_locales`), from the
-- payer locale set (`CHECKOUT_LOCALES`). The column default is a constant, so
-- ADD COLUMN is catalog-only (no rewrite). HAND EDIT: the CHECK is added NOT
-- VALID (no scan under the ACCESS EXCLUSIVE lock; it is still enforced on every
-- write) and 0109 (post) validates it. Every existing row holds the empty
-- default, so validation cannot fail.
ALTER TABLE "customers" ADD COLUMN "preferred_locales" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_preferred_locales_check" CHECK (cardinality(preferred_locales) <= 15 and array_position(preferred_locales, null) is null and preferred_locales <@ ARRAY['ar', 'bn', 'ca', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'pt', 'ru', 'tr', 'zh']::text[]) NOT VALID;

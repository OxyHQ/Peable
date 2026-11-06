-- oxy:deploy-phase=pre
-- The payer locale set widens (see 0102), on payment links. Apart from 0102
-- because checkout_sessions is a hot table and its DDL sits alone. NOT VALID,
-- validated by 0104 (post); every existing value is in the new set.
ALTER TABLE "payment_links" DROP CONSTRAINT "payment_links_options_check";--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_options_check" CHECK (customer_creation in ('always', 'if_required') and submit_type in ('auto', 'pay', 'book', 'donate') and (locale is null or locale in ('ar', 'bn', 'ca', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'pt', 'ru', 'tr', 'zh'))) NOT VALID;

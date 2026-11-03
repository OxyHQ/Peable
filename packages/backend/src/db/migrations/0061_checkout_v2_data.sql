-- oxy:deploy-phase=post
-- Orbit Phase 3 (checkout v2), part 3 of 3: the data, the validations, the retired column.
-- HAND EDIT: drizzle-kit generated only the last statement (the DROP of the
-- retired column); steps 1–3 are written above it by hand. Runs after the new
-- image serves alone, so no pre-Phase-3 writer remains.
--
-- 1. Sessions created before the order model get what the order model says
--    they are: a session client secret, the wrapped payment's deadline, the
--    status and payment status its payment implies, the amount as their
--    subtotal and ONE line item (the amount, quantity 1). Expressed exactly as
--    the new code would have written them, so nothing reads them differently.
-- 2. Price links created before Phase 3 become links over the catalog: one
--    product ('Payment', with the link id in metadata) and one one-time price
--    of the link's amount each, the link's line item naming it, and the link's
--    amount cleared — only contribution links keep an amount. A success URL
--    becomes `after_completion` redirect. No catalog events are recorded for
--    these rows: nothing about them happened now.
-- 3. VALIDATE every constraint checkout_v2 / checkout_sessions_v2 added NOT VALID, under SHARE UPDATE
--    EXCLUSIVE (reads and writes continue).
-- 4. (last) DROP payment_links.success_url — step 2 copied it into
--    after_completion_url, and no serving image reads it.
CREATE OR REPLACE FUNCTION pg_temp.peable_uuid7(ts timestamptz) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-7' || substr(h, 14, 3) || '-'
    || substr('89ab', 1 + floor(random() * 4)::int, 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12)
  FROM (
    SELECT lpad(to_hex(floor(extract(epoch FROM ts) * 1000)::bigint), 12, '0')
      || md5(random()::text || clock_timestamp()::text) AS h
  ) AS x
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION pg_temp.peable_hex24() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT substr(replace(gen_random_uuid()::text, '-', ''), 1, 24)
$$;
--> statement-breakpoint
UPDATE checkout_sessions s SET
  client_secret = coalesce(s.client_secret, s.public_id || '_secret_' || replace(gen_random_uuid()::text, '-', '')),
  expires_at = coalesce(s.expires_at, pi.expires_at),
  amount_subtotal = s.amount,
  status = CASE
    WHEN pi.status IN ('succeeded', 'requires_capture') OR (pi.rail = 'faircoin' AND pi.status = 'processing') THEN 'complete'
    WHEN pi.status = 'canceled' THEN 'expired'
    ELSE 'open' END,
  payment_status = CASE WHEN pi.status = 'succeeded' THEN 'paid' ELSE 'unpaid' END,
  completed_at = CASE
    WHEN pi.status IN ('succeeded', 'requires_capture') OR (pi.rail = 'faircoin' AND pi.status = 'processing') THEN pi.updated_at
    ELSE NULL END,
  expired_at = CASE WHEN pi.status = 'canceled' THEN coalesce(pi.canceled_at, pi.updated_at) ELSE NULL END
FROM payment_intents pi
WHERE pi.id = s.payment_intent_id AND s.client_secret IS NULL;
--> statement-breakpoint
INSERT INTO checkout_session_line_items (id, public_id, session_id, merchant_id, position, description, currency, price, quantity, amount_subtotal, amount_discount, amount_tax, amount_total, created_at, updated_at)
SELECT pg_temp.peable_uuid7(s.created_at), 'li_' || pg_temp.peable_hex24(), s.id, s.merchant_id, 0, 'Payment', s.currency,
       jsonb_build_object('billingScheme', 'per_unit', 'unitAmount', s.amount, 'tiers', NULL, 'tiersMode', NULL, 'transformQuantity', NULL, 'recurring', NULL),
       1, s.amount, '0', '0', s.amount, s.created_at, s.created_at
FROM checkout_sessions s
WHERE s.mode = 'payment' AND s.payment_intent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM checkout_session_line_items li WHERE li.session_id = s.id)
  -- A FairCoin billing invoice's session shows its quote, not a line.
  AND NOT EXISTS (SELECT 1 FROM faircoin_billing_invoices f WHERE f.payment_intent_id = s.payment_intent_id);
--> statement-breakpoint
CREATE TEMP TABLE peable_link_catalog ON COMMIT DROP AS
SELECT l.id AS link_id, l.merchant_id, l.amount, l.currency, l.public_id AS link_public_id, l.created_at,
       pg_temp.peable_uuid7(l.created_at) AS product_id, 'prod_' || pg_temp.peable_hex24() AS product_public_id,
       pg_temp.peable_uuid7(l.created_at) AS price_id, 'price_' || pg_temp.peable_hex24() AS price_public_id
FROM payment_links l
WHERE l.contribution IS NULL AND l.amount IS NOT NULL;
--> statement-breakpoint
INSERT INTO products (id, public_id, merchant_id, active, name, metadata, created_at, updated_at)
SELECT c.product_id, c.product_public_id, c.merchant_id, true, 'Payment',
       jsonb_build_object('payment_link', c.link_public_id), c.created_at, c.created_at
FROM peable_link_catalog c;
--> statement-breakpoint
INSERT INTO prices (id, public_id, merchant_id, product_id, active, currency, unit_amount, billing_scheme, type, tax_behavior, metadata, created_at, updated_at)
SELECT c.price_id, c.price_public_id, c.merchant_id, c.product_id, true, c.currency, c.amount, 'per_unit', 'one_time', 'unspecified',
       '{}'::jsonb, c.created_at, c.created_at
FROM peable_link_catalog c;
--> statement-breakpoint
UPDATE products p SET default_price_id = c.price_id FROM peable_link_catalog c WHERE p.id = c.product_id;
--> statement-breakpoint
INSERT INTO payment_link_line_items (id, link_id, merchant_id, position, price_id, quantity, created_at)
SELECT pg_temp.peable_uuid7(c.created_at), c.link_id, c.merchant_id, 0, c.price_id, 1, c.created_at
FROM peable_link_catalog c;
--> statement-breakpoint
UPDATE payment_links l SET amount = NULL FROM peable_link_catalog c WHERE l.id = c.link_id;
--> statement-breakpoint
UPDATE payment_links SET after_completion_type = 'redirect', after_completion_url = success_url, after_completion_message = NULL
WHERE success_url IS NOT NULL AND after_completion_url IS NULL;
--> statement-breakpoint
ALTER TABLE "events" VALIDATE CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "payment_links" VALIDATE CONSTRAINT "payment_links_amount_shape_check";--> statement-breakpoint
ALTER TABLE "payment_links" VALIDATE CONSTRAINT "payment_links_after_completion_check";--> statement-breakpoint
ALTER TABLE "payment_links" VALIDATE CONSTRAINT "payment_links_completed_sessions_check";--> statement-breakpoint
ALTER TABLE "payment_links" VALIDATE CONSTRAINT "payment_links_custom_fields_check";--> statement-breakpoint
ALTER TABLE "payment_links" VALIDATE CONSTRAINT "payment_links_options_check";--> statement-breakpoint
ALTER TABLE "payment_links" VALIDATE CONSTRAINT "payment_links_amount_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" VALIDATE CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_setup_intent_id_setup_intents_id_fk";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_payment_link_id_payment_links_id_fk";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_customer_fkey";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_coupon_fkey";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_promotion_code_fkey";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_amounts_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_mode_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_status_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_payment_status_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_ui_mode_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_locale_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_submit_type_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_customer_creation_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_automatic_tax_status_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_custom_fields_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_mode_objects_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_status_instants_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_payment_status_agrees_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_discount_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_client_secret_check";--> statement-breakpoint
ALTER TABLE "checkout_sessions" VALIDATE CONSTRAINT "checkout_sessions_expires_at_check";--> statement-breakpoint
ALTER TABLE "payment_links" DROP COLUMN "success_url";

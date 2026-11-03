-- oxy:deploy-phase=post
-- oxy:lock-review=the DML before the DDL touches only rows the outgoing image wrote during the rollout (0040 already carried every older row over); the ACCESS EXCLUSIVE locks are column drops, one SET NOT NULL and one foreign key, each a single scan of webhook_deliveries / merchants under the same lock.
-- Events and webhook endpoints (ADR 0014 D4), the CONTRACT half.
--
-- 1-7: the same idempotent backfill as 0040, for the rows the outgoing image
--      wrote while both ran (public evt_ ids, no endpoint), then the removal of
--      what cannot be carried over. Hand-written.
-- Then (drizzle-kit generated): the merchant's single webhook (url + secret)
--      is gone — webhook_endpoints replaced it — and a delivery no longer
--      carries its own envelope, event type or intent: it names its event and
--      its endpoint. HAND EDIT: the event_id foreign key is added VALID — the
--      file already holds ACCESS EXCLUSIVE on webhook_deliveries for the drops,
--      so a NOT VALID + later VALIDATE would only add a second scan.
-- Last: VALIDATE the two foreign keys 0038 added NOT VALID (hand-written).
-- A uuid v7 at a given instant, matching `generatedId()` (k-sortable, so the
-- keyset walk over the backfilled rows keeps creation order). A pg_temp
-- function: it lives for this migration's session and leaves nothing behind.
CREATE OR REPLACE FUNCTION pg_temp.peable_uuid7(ts timestamptz) RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-7' || substr(h, 14, 3) || '-'
    || substr('89ab', 1 + floor(random() * 4)::int, 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12)
  FROM (
    SELECT lpad(to_hex(floor(extract(epoch FROM ts) * 1000)::bigint), 12, '0')
      || md5(random()::text || clock_timestamp()::text) AS h
  ) AS x
$$;
--> statement-breakpoint
-- 1. One endpoint per merchant that had a usable webhook: every event (`*`), the
--    merchant's own secret carried over byte for byte so its receiver keeps
--    verifying. A merchant that already has an endpoint is left alone.
INSERT INTO webhook_endpoints (id, public_id, merchant_id, url, enabled_events, metadata, api_version, secret, status, created_at, updated_at)
SELECT pg_temp.peable_uuid7(clock_timestamp()),
       'we_' || substr(md5(random()::text || m.id || clock_timestamp()::text), 1, 24),
       m.id, m.webhook_url, ARRAY['*']::text[], '{}'::jsonb, '2026-11-03', m.webhook_secret, 'enabled',
       date_trunc('milliseconds', now()), date_trunc('milliseconds', now())
FROM merchants m
WHERE m.webhook_url IS NOT NULL
  AND m.webhook_url ~ '^https?://'
  AND char_length(m.webhook_url) <= 2048
  AND m.webhook_secret IS NOT NULL
  AND char_length(m.webhook_secret) >= 1
  AND NOT EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.merchant_id = m.id);
--> statement-breakpoint
-- 2. One event per legacy envelope. A redelivery copied the envelope (same
--    `evt_…`), so DISTINCT ON keeps the first. Envelopes from before the outbox
--    stored bodies (`'{}'`) cannot become events and are removed post-rollout.
INSERT INTO events (id, public_id, merchant_id, type, api_version, data_object, account, payment_intent_id, created_at)
SELECT pg_temp.peable_uuid7(src.created_at), src.event_id, src.merchant_id, src.event_type, '2026-11-03',
       src.payload -> 'data' -> 'object', src.payload ->> 'account', src.payment_intent_id, src.created_at
FROM (
  SELECT DISTINCT ON (d.event_id)
         d.event_id, d.merchant_id, d.event_type, d.payload, d.payment_intent_id,
         date_trunc('milliseconds', CASE
           WHEN jsonb_typeof(d.payload -> 'created') = 'number'
             THEN to_timestamp((d.payload ->> 'created')::double precision)
           ELSE d.created_at
         END) AS created_at
  FROM webhook_deliveries d
  WHERE d.event_id LIKE 'evt\_%'
    AND d.event_type IS NOT NULL
    AND jsonb_typeof(d.payload -> 'data' -> 'object') = 'object'
  ORDER BY d.event_id, d.created_at
) AS src
WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.public_id = src.event_id);
--> statement-breakpoint
-- 3. A delivery now names its event by the event's PRIMARY key, never the public one.
UPDATE webhook_deliveries d
SET event_id = e.id
FROM events e
WHERE d.event_id LIKE 'evt\_%' AND e.public_id = d.event_id;
--> statement-breakpoint
-- 4. And the endpoint it went to: the merchant's migrated endpoint, its oldest.
UPDATE webhook_deliveries d
SET endpoint_id = (
  SELECT w.id FROM webhook_endpoints w
  WHERE w.merchant_id = d.merchant_id
  ORDER BY w.created_at, w.id
  LIMIT 1
)
WHERE d.endpoint_id IS NULL;
--> statement-breakpoint
-- 5. A relayed billing observation keeps being relayed: its moment, and its event.
UPDATE recurring_observation_outbox o
SET relayed_at = d.created_at,
    event_id = CASE WHEN d.event_id NOT LIKE 'evt\_%' THEN d.event_id END
FROM webhook_deliveries d
WHERE o.delivery_id = d.id AND o.relayed_at IS NULL;
--> statement-breakpoint
-- 6. The relay no longer reads delivery_id (dropped below); release it so the
--    deliveries removed next are not held by its RESTRICT reference. Step 5
--    already recorded relayed_at for every one of them.
UPDATE recurring_observation_outbox SET delivery_id = NULL WHERE delivery_id IS NOT NULL;
--> statement-breakpoint
-- 7. What has no event (an envelope from before bodies were stored) or no
--    endpoint (a merchant with no usable webhook) is not a delivery in the new
--    model. Removed, not invented.
DELETE FROM webhook_deliveries WHERE event_id LIKE 'evt\_%' OR endpoint_id IS NULL;
--> statement-breakpoint
ALTER TABLE "recurring_observation_outbox" DROP CONSTRAINT "recurring_observation_outbox_delivery_id_webhook_deliveries_id_fk";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP CONSTRAINT "webhook_deliveries_payment_intent_id_payment_intents_id_fk";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "endpoint_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "webhook_url";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "webhook_secret";--> statement-breakpoint
ALTER TABLE "recurring_observation_outbox" DROP COLUMN "delivery_id";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP COLUMN "payment_intent_id";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP COLUMN "event_type";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" DROP COLUMN "payload";--> statement-breakpoint
ALTER TABLE "webhook_deliveries" VALIDATE CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk";--> statement-breakpoint
ALTER TABLE "recurring_observation_outbox" VALIDATE CONSTRAINT "recurring_observation_outbox_event_id_events_id_fk";

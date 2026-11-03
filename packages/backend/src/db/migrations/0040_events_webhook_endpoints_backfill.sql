-- oxy:deploy-phase=pre
-- Events and webhook endpoints (ADR 0014 D4): carry the data over before the new
-- image serves. Hand-written (drizzle-kit generate --custom). Every statement is
-- idempotent; 0041 runs the same backfill again after the rollout, for the rows
-- the outgoing image wrote in between.
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
-- 6. History that cannot be represented as "one event sent to one endpoint" is
--    removed, not invented: an envelope from before bodies were stored (no
--    event could be made of it) and a delivery of a merchant with no usable
--    webhook (no endpoint). All terminal — the outgoing image never enqueues
--    for a merchant without one. A row still referenced by a relayed billing
--    observation is kept for 0041, which first releases that reference.
DELETE FROM webhook_deliveries d
WHERE (d.event_id LIKE 'evt\_%' OR d.endpoint_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM recurring_observation_outbox o WHERE o.delivery_id = d.id);

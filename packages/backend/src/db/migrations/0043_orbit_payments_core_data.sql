-- oxy:deploy-phase=pre
-- ADR 0019 — Orbit payments core, the DATA half. DML only: no DDL on any
-- table, so no ACCESS EXCLUSIVE lock is held while it runs (0042 did the DDL).
--
-- 1. payment_intents: the pre-0019 statuses become Stripe's, per rail.
--      faircoin created | awaiting_approval | approved  → requires_action
--      faircoin broadcast | confirming                   → processing
--      faircoin failed (underpaid)                       → canceled, reason 'underpaid',
--                                                          last_payment_error payment_underpaid
--      card     created                                  → requires_payment_method
--      card     failed (a declined attempt)              → requires_payment_method,
--                                                          last_payment_error card_error
--      settled | refunded | partially_refunded           → succeeded, amount_received = amount
--                                                          (refund state lives on `refunds`;
--                                                          amount_refunded is their sum)
--      expired                                           → canceled, reason 'abandoned'
--      rejected                                          → canceled, reason NULL (never recorded)
--      card requires_action | processing                 → unchanged
--    A cancelled row's `canceled_at` is its `updated_at` — the last write, which
--    was the cancellation. `updated_at` itself is left as it was.
-- 2. charges: one `ch_…` per card intent that succeeded — the invariant every
--    later card success maintains in its own transition. Ids are uuid v7 built
--    from the intent's `updated_at`, so keyset order stays creation order.
-- 3. events (ADR 0014 D4): stored event types renamed to Stripe's and each
--    `data_object` rewritten to the 0019 wire, so `/v1/events` and a
--    redelivery render what every new event renders. A `refunded` /
--    `partially_refunded` event becomes `charge.refunded` carrying the Charge;
--    its `amount_refunded` is the payment's amount for a full refund and the
--    current succeeded sum (capped) for a partial one. Deliveries carry no
--    envelope of their own since 0041, so nothing else holds the old names.
-- 4. webhook_endpoints.enabled_events: each old name subscribed becomes the
--    new one it maps to (deduplicated), so an endpoint keeps hearing about the
--    same moments. `*` is untouched.
-- 5. idempotency_keys: emptied. A stored response is a 24-hour cache of a wire
--    this release retires; business idempotency (`payment_intents.idempotency_key`,
--    `external_ref`) still converges a retry.

CREATE FUNCTION pg_temp.orbit_0019_status(old text, rail text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN rail = 'faircoin' AND old IN ('created', 'awaiting_approval', 'approved') THEN 'requires_action'
    WHEN rail = 'faircoin' AND old IN ('broadcast', 'confirming') THEN 'processing'
    WHEN rail = 'faircoin' AND old = 'failed' THEN 'canceled'
    WHEN rail = 'card' AND old IN ('created', 'failed') THEN 'requires_payment_method'
    WHEN old IN ('settled', 'refunded', 'partially_refunded') THEN 'succeeded'
    WHEN old IN ('expired', 'rejected') THEN 'canceled'
    ELSE old
  END
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.orbit_0019_reason(old text, rail text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN old = 'expired' THEN 'abandoned'
    WHEN rail = 'faircoin' AND old = 'failed' THEN 'underpaid'
    ELSE NULL
  END
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.orbit_0019_error(old text, rail text) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN rail = 'card' AND old = 'failed' THEN jsonb_build_object(
      'type', 'card_error', 'code', NULL, 'decline_code', NULL,
      'message', 'The last payment attempt was declined.')
    WHEN rail = 'faircoin' AND old = 'failed' THEN jsonb_build_object(
      'type', 'payment_error', 'code', 'payment_underpaid', 'decline_code', NULL,
      'message', 'The transaction paid less than the amount due.')
    ELSE NULL
  END
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.orbit_0019_uuid7(at timestamptz, seed text) RETURNS text
LANGUAGE sql VOLATILE AS $$
  SELECT substr(ts, 1, 8) || '-' || substr(ts, 9, 4) || '-7' || substr(r, 1, 3) || '-'
      || substr('89ab', 1 + (get_byte(decode(substr(r, 4, 2), 'hex'), 0) % 4), 1)
      || substr(r, 6, 3) || '-' || substr(r, 9, 12)
  FROM (SELECT lpad(to_hex(floor(extract(epoch FROM at) * 1000)::bigint), 12, '0') AS ts,
               md5(random()::text || seed) AS r) AS parts
$$;
--> statement-breakpoint
UPDATE "payment_intents" SET
  "cancellation_reason" = pg_temp.orbit_0019_reason("status", "rail"),
  "canceled_at" = CASE
    WHEN pg_temp.orbit_0019_status("status", "rail") = 'canceled' THEN "updated_at"
    ELSE NULL
  END,
  "amount_received" = CASE
    WHEN "status" IN ('settled', 'refunded', 'partially_refunded') THEN "amount"
    ELSE '0'
  END,
  "last_payment_error" = pg_temp.orbit_0019_error("status", "rail"),
  "status" = pg_temp.orbit_0019_status("status", "rail")
WHERE "status" IN ('created', 'awaiting_approval', 'approved', 'broadcast', 'confirming',
                   'settled', 'refunded', 'partially_refunded', 'expired', 'failed', 'rejected');
--> statement-breakpoint
INSERT INTO "charges" ("id", "public_id", "merchant_id", "payment_intent_id", "amount",
                       "amount_captured", "currency", "created_at", "updated_at")
SELECT pg_temp.orbit_0019_uuid7(p."updated_at", p."id"),
       'ch_' || substr(md5(random()::text || p."id" || clock_timestamp()::text), 1, 24),
       p."merchant_id", p."id", p."amount", p."amount_received", p."currency",
       p."updated_at", p."updated_at"
FROM "payment_intents" p
WHERE p."rail" = 'card' AND p."status" = 'succeeded'
  AND NOT EXISTS (SELECT 1 FROM "charges" c WHERE c."payment_intent_id" = p."id");
--> statement-breakpoint
CREATE FUNCTION pg_temp.orbit_0019_intent(obj jsonb, m_public text, m_confirmations integer,
                                          charge_public text, refunded_sum text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  old text := obj ->> 'status';
  rail text := coalesce(obj ->> 'rail', 'faircoin');
  new_status text := pg_temp.orbit_0019_status(old, rail);
  received text := CASE WHEN new_status = 'succeeded' THEN obj ->> 'amount' ELSE '0' END;
BEGIN
  RETURN (obj - 'network' - 'address' - 'txid' - 'confirmations') || jsonb_build_object(
    'status', new_status,
    'payment_method_types', jsonb_build_array(rail),
    'amount_capturable', '0',
    'amount_received', received,
    'amount_refunded', coalesce(refunded_sum, '0'),
    'capture_method', 'automatic',
    'setup_future_usage', NULL,
    'customer', NULL,
    'payment_method', NULL,
    'latest_charge', CASE WHEN rail = 'card' AND new_status = 'succeeded' THEN charge_public END,
    'next_action', NULL,
    'last_payment_error', pg_temp.orbit_0019_error(old, rail),
    'cancellation_reason', pg_temp.orbit_0019_reason(old, rail),
    'canceled_at', CASE WHEN new_status = 'canceled' THEN obj -> 'updated_at' END,
    'description', NULL,
    'receipt_email', NULL,
    'statement_descriptor_suffix', NULL,
    'shipping', NULL,
    'faircoin', CASE WHEN rail = 'faircoin' THEN jsonb_build_object(
      'network', obj -> 'network',
      'address', obj -> 'address',
      'txid', obj -> 'txid',
      'confirmations', coalesce(obj -> 'confirmations', '0'::jsonb),
      'required_confirmations', m_confirmations) END,
    'merchant_id', m_public,
    'can_expire', new_status IN ('requires_payment_method', 'requires_confirmation', 'requires_action'));
END
$$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.orbit_0019_charge(obj jsonb, charge_public text, charge_created timestamptz,
                                          refunded_sum text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  full_refund boolean := obj ->> 'status' = 'refunded';
  amount text := obj ->> 'amount';
BEGIN
  RETURN jsonb_build_object(
    'id', charge_public,
    'object', 'charge',
    'livemode', coalesce(obj -> 'livemode', 'false'::jsonb),
    'payment_intent', obj -> 'id',
    'customer', NULL,
    'payment_method', NULL,
    'amount', amount,
    'amount_captured', amount,
    'amount_refunded', CASE
      WHEN full_refund THEN amount
      ELSE least(coalesce(refunded_sum, '0')::numeric, amount::numeric)::text
    END,
    'currency', obj -> 'currency',
    'status', 'succeeded',
    'paid', true,
    'captured', true,
    'refunded', full_refund,
    'disputed', false,
    'outcome', NULL,
    'payment_method_details', NULL,
    'receipt_url', NULL,
    'balance_transaction', NULL,
    'description', NULL,
    'receipt_email', NULL,
    'metadata', coalesce(obj -> 'metadata', '{}'::jsonb),
    'created', floor(extract(epoch FROM charge_created))::bigint);
END
$$;
--> statement-breakpoint
UPDATE "events" e SET
  "type" = mapped.new_type,
  "data_object" = CASE
    WHEN e."type" IN ('payment_intent.refunded', 'payment_intent.partially_refunded')
      THEN pg_temp.orbit_0019_charge(e."data_object", c."public_id", c."created_at", refunded.total)
    WHEN e."type" IN ('payment_intent.disputed', 'payment_intent.dispute_closed')
      THEN e."data_object"
    ELSE pg_temp.orbit_0019_intent(e."data_object", m."public_id", m."required_confirmations",
                                   c."public_id", refunded.total)
  END
FROM (VALUES
    ('payment_intent.confirming', 'payment_intent.processing'),
    ('payment_intent.settled', 'payment_intent.succeeded'),
    ('payment_intent.failed', 'payment_intent.payment_failed'),
    ('payment_intent.rejected', 'payment_intent.canceled'),
    ('payment_intent.expired', 'payment_intent.canceled'),
    ('payment_intent.refunded', 'charge.refunded'),
    ('payment_intent.partially_refunded', 'charge.refunded'),
    ('payment_intent.disputed', 'charge.dispute.created'),
    ('payment_intent.dispute_closed', 'charge.dispute.closed')
  ) AS mapped(old_type, new_type),
  "payment_intents" p
  JOIN "merchants" m ON m."id" = p."merchant_id"
  LEFT JOIN "charges" c ON c."payment_intent_id" = p."id"
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(r."amount"::numeric), 0)::text AS total
    FROM "refunds" r
    WHERE r."payment_intent_id" = p."id" AND r."status" = 'succeeded'
  ) refunded ON true
WHERE e."type" = mapped.old_type AND p."id" = e."payment_intent_id";
--> statement-breakpoint
UPDATE "webhook_endpoints" w SET "enabled_events" = (
  SELECT array_agg(DISTINCT renamed ORDER BY renamed)
  FROM unnest(w."enabled_events") AS old(name)
  CROSS JOIN LATERAL (SELECT CASE old.name
    WHEN 'payment_intent.confirming' THEN 'payment_intent.processing'
    WHEN 'payment_intent.settled' THEN 'payment_intent.succeeded'
    WHEN 'payment_intent.failed' THEN 'payment_intent.payment_failed'
    WHEN 'payment_intent.rejected' THEN 'payment_intent.canceled'
    WHEN 'payment_intent.expired' THEN 'payment_intent.canceled'
    WHEN 'payment_intent.refunded' THEN 'charge.refunded'
    WHEN 'payment_intent.partially_refunded' THEN 'charge.refunded'
    WHEN 'payment_intent.disputed' THEN 'charge.dispute.created'
    WHEN 'payment_intent.dispute_closed' THEN 'charge.dispute.closed'
    ELSE old.name END AS renamed) AS mapped
)
WHERE w."enabled_events" && ARRAY['payment_intent.confirming', 'payment_intent.settled',
  'payment_intent.failed', 'payment_intent.rejected', 'payment_intent.expired',
  'payment_intent.refunded', 'payment_intent.partially_refunded', 'payment_intent.disputed',
  'payment_intent.dispute_closed']::text[];
--> statement-breakpoint
DELETE FROM "idempotency_keys";

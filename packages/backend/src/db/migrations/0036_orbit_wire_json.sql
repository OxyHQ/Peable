-- oxy:deploy-phase=pre
-- oxy:lock-review=DML only: rewrites jsonb values in place, no DDL on any table; row locks are taken per row and the outbox claims with SKIP LOCKED.
--
-- ADR 0014: the Orbit wire is snake_case with integer Unix-second instants, and
-- it was changed at the root — so every jsonb column that STORES a wire object
-- is rewritten to the new shape here, once, instead of being read in two shapes
-- forever. Pre-deploy: the code that ships with this migration reads only the
-- new shape.
--
-- What is rewritten (whole value unless noted):
--   tax_calculations.result, tax_transactions.reversal, tax_settings.head_office,
--   faircoin_renewal_authorizations.consent / .revocation,
--   faircoin_billing_invoices.fx_quote, billing_operations.result,
--   webhook_deliveries.payload (stored event envelopes, so a redelivery sends the
--   wire every other delivery uses);
--   and ONLY the `taxQuote` member of faircoin_billing_invoices.tax_snapshot,
--   billing_operations.tax_checkout_snapshot and billing_renewal_taxes.snapshot —
--   the snapshot's own keys (`taxQuote`, `quoteDigest`, `offer`) are internal
--   storage, and the CHECKs on those tables read them.
--
-- Rules, applied recursively: `createdAt` → `created`; every other key camelCase
-- → snake_case; a full ISO-8601 instant string → integer Unix seconds;
-- `schemaVersion` → `schema_version: 2`. A `metadata` value is the merchant's own
-- data and is copied verbatim, keys included.
--
-- Signed tax quotes inside the snapshots were signed over their schema 1
-- encoding. The signature and `quoteDigest` are kept as recorded: they are the
-- evidence of what was signed at checkout, nothing re-verifies a stored snapshot,
-- and Peable cannot re-sign history without misdating it.

CREATE FUNCTION pg_temp.orbit_wire(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb;
  k text;
  v jsonb;
  out_key text;
  text_value text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      result := '{}'::jsonb;
      FOR k, v IN SELECT key, val FROM jsonb_each(value) AS e(key, val) LOOP
        IF k = 'createdAt' THEN
          out_key := 'created';
        ELSE
          out_key := lower(regexp_replace(k, '([a-z0-9])([A-Z])', '\1_\2', 'g'));
        END IF;
        IF k = 'metadata' THEN
          result := result || jsonb_build_object(out_key, v);
        ELSIF k = 'schemaVersion' THEN
          result := result || jsonb_build_object(out_key, 2);
        ELSE
          result := result || jsonb_build_object(out_key, pg_temp.orbit_wire(v));
        END IF;
      END LOOP;
      RETURN result;
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(pg_temp.orbit_wire(elem) ORDER BY ord), '[]'::jsonb)
        INTO result
        FROM jsonb_array_elements(value) WITH ORDINALITY AS a(elem, ord);
      RETURN result;
    WHEN 'string' THEN
      text_value := value #>> '{}';
      IF text_value ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$' THEN
        RETURN to_jsonb(floor(extract(epoch FROM text_value::timestamptz))::bigint);
      END IF;
      RETURN value;
    ELSE
      RETURN value;
  END CASE;
END
$$;
--> statement-breakpoint
UPDATE "tax_calculations" SET "result" = pg_temp.orbit_wire("result");
--> statement-breakpoint
UPDATE "tax_transactions" SET "reversal" = pg_temp.orbit_wire("reversal") WHERE "reversal" IS NOT NULL;
--> statement-breakpoint
UPDATE "tax_settings" SET "head_office" = pg_temp.orbit_wire("head_office") WHERE "head_office" IS NOT NULL;
--> statement-breakpoint
UPDATE "faircoin_renewal_authorizations"
  SET "consent" = pg_temp.orbit_wire("consent"),
      "revocation" = CASE WHEN "revocation" IS NULL THEN NULL ELSE pg_temp.orbit_wire("revocation") END;
--> statement-breakpoint
UPDATE "faircoin_billing_invoices"
  SET "fx_quote" = pg_temp.orbit_wire("fx_quote"),
      "tax_snapshot" = jsonb_set("tax_snapshot", '{taxQuote}', pg_temp.orbit_wire("tax_snapshot" -> 'taxQuote'))
  WHERE true;
--> statement-breakpoint
UPDATE "billing_operations"
  SET "result" = CASE WHEN "result" IS NULL THEN NULL ELSE pg_temp.orbit_wire("result") END,
      "tax_checkout_snapshot" = CASE
        WHEN "tax_checkout_snapshot" ? 'taxQuote'
          THEN jsonb_set("tax_checkout_snapshot", '{taxQuote}', pg_temp.orbit_wire("tax_checkout_snapshot" -> 'taxQuote'))
        ELSE "tax_checkout_snapshot"
      END
  WHERE "result" IS NOT NULL OR "tax_checkout_snapshot" IS NOT NULL;
--> statement-breakpoint
UPDATE "billing_renewal_taxes"
  SET "snapshot" = jsonb_set("snapshot", '{taxQuote}', pg_temp.orbit_wire("snapshot" -> 'taxQuote'))
  WHERE "snapshot" ? 'taxQuote';
--> statement-breakpoint
UPDATE "webhook_deliveries" SET "payload" = pg_temp.orbit_wire("payload") WHERE "payload" <> '{}'::jsonb;
--> statement-breakpoint
DROP FUNCTION pg_temp.orbit_wire(jsonb);

-- oxy:deploy-phase=pre
-- oxy:lock-review=DML only: rewrites jsonb values in place, no DDL on any table; creates two functions that 0076 drops.
--
-- ADR 0014 D1, its last exception removed: every Peable Tax amount and every
-- amount in a signed billing document is a base-unit integer STRING on the
-- wire. The wire was changed at the root, so every jsonb column that STORES
-- one of those objects is rewritten to the new shape here instead of being
-- read in two shapes forever. Pre-deploy: the code that ships with this
-- migration reads only the new shape. 0076 (post) runs the same rewrite again
-- for the rows the previous image wrote while the new one rolled out, then
-- drops both functions.
--
-- What is rewritten:
--   tax_calculations.result, tax_transactions.reversal (whole value);
--   faircoin_billing_invoices.fx_quote (whole value);
--   ONLY the `taxQuote` member of faircoin_billing_invoices.tax_snapshot,
--   billing_operations.tax_checkout_snapshot and billing_renewal_taxes.snapshot
--   (the snapshot's own keys are internal storage), whose `schema_version`
--   becomes 3;
--   idempotency_keys.response_body of the two idempotent tax POSTs, so a replay
--   inside its 24 hours answers the one wire.
--
-- Rule, applied recursively: a JSON NUMBER under one of the amount keys below
-- becomes the decimal string of the same integer. The text of a jsonb number
-- is its exact numeric value — no float is involved — and anything that is not
-- an integer (a fraction, an exponent jsonb did not normalise) aborts the
-- migration rather than being rounded. Every other value (`quantity`, instants,
-- `schema_version` outside a quote) is copied unchanged; a value that is
-- already a string is left as it is, so the rewrite can run twice.
--
-- Signed quotes inside the snapshots were signed over their schema 2
-- encoding. The signature and `quoteDigest` are kept as recorded: they are the
-- evidence of what was signed at checkout, nothing re-verifies a stored
-- snapshot, and Peable cannot re-sign history without misdating it (0036 made
-- the same call for schema 1).

CREATE FUNCTION peable_tax_amount_strings(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  result jsonb;
  k text;
  v jsonb;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      result := '{}'::jsonb;
      FOR k, v IN SELECT key, val FROM jsonb_each(value) AS e(key, val) LOOP
        IF jsonb_typeof(v) = 'number' AND k IN (
          'amount', 'amount_tax', 'amount_net', 'amount_total', 'taxable_amount', 'tax_amount',
          'tax_amount_exclusive', 'tax_amount_inclusive', 'gross_minor_units', 'net_minor_units',
          'tax_minor_units', 'merchant_fee_minor_units', 'taxable_minor_units'
        ) THEN
          IF (v #>> '{}') !~ '^(0|-?[1-9][0-9]*)$' THEN
            RAISE EXCEPTION 'amount % is not an integer: %', k, v #>> '{}';
          END IF;
          result := result || jsonb_build_object(k, v #>> '{}');
        ELSE
          result := result || jsonb_build_object(k, peable_tax_amount_strings(v));
        END IF;
      END LOOP;
      RETURN result;
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(peable_tax_amount_strings(elem) ORDER BY ord), '[]'::jsonb)
        INTO result
        FROM jsonb_array_elements(value) WITH ORDINALITY AS a(elem, ord);
      RETURN result;
    ELSE
      RETURN value;
  END CASE;
END
$$;
--> statement-breakpoint
CREATE FUNCTION peable_tax_amounts_to_strings() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "tax_calculations" SET "result" = peable_tax_amount_strings("result")
    WHERE peable_tax_amount_strings("result") <> "result";
  UPDATE "tax_transactions" SET "reversal" = peable_tax_amount_strings("reversal")
    WHERE "reversal" IS NOT NULL AND peable_tax_amount_strings("reversal") <> "reversal";
  UPDATE "faircoin_billing_invoices"
    SET "fx_quote" = peable_tax_amount_strings("fx_quote"),
        "tax_snapshot" = jsonb_set(
          "tax_snapshot",
          '{taxQuote}',
          jsonb_set(peable_tax_amount_strings("tax_snapshot" -> 'taxQuote'), '{schema_version}', '3')
        )
    WHERE "tax_snapshot" -> 'taxQuote' ->> 'schema_version' = '2'
       OR peable_tax_amount_strings("fx_quote") <> "fx_quote";
  UPDATE "billing_operations"
    SET "tax_checkout_snapshot" = jsonb_set(
      "tax_checkout_snapshot",
      '{taxQuote}',
      jsonb_set(peable_tax_amount_strings("tax_checkout_snapshot" -> 'taxQuote'), '{schema_version}', '3')
    )
    WHERE "tax_checkout_snapshot" -> 'taxQuote' ->> 'schema_version' = '2';
  UPDATE "billing_renewal_taxes"
    SET "snapshot" = jsonb_set(
      "snapshot",
      '{taxQuote}',
      jsonb_set(peable_tax_amount_strings("snapshot" -> 'taxQuote'), '{schema_version}', '3')
    )
    WHERE "snapshot" -> 'taxQuote' ->> 'schema_version' = '2';
  UPDATE "idempotency_keys" SET "response_body" = peable_tax_amount_strings("response_body")
    WHERE "method" = 'POST'
      AND ("path" = '/v1/tax/calculations' OR "path" ~ '^/v1/tax/transactions/[^/]+/reversals$')
      AND "response_body" IS NOT NULL
      AND peable_tax_amount_strings("response_body") <> "response_body";
END
$$;
--> statement-breakpoint
SELECT peable_tax_amounts_to_strings();

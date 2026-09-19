-- oxy:deploy-phase=pre
-- `payment_intents.provider_charge_id` — the CHARGE, beside the payment.
--
-- A payment and the charge it produces are different objects with different
-- ids, and a transfer's `source_transaction` names the CHARGE.
-- `transferService` used to hand it `provider_object_id` (a `pi_…`), which
-- Stripe refuses with `No such charge` — so every multi-seller settlement
-- failed, at the provider, which reads as an outage rather than as a mix-up two
-- functions away. This column records the association once, so a cart with N
-- sellers does not re-read the payment N times.
--
-- `pre`, and safe while the old image still serves: the column is nullable with
-- no default, so the outgoing image simply never writes it. The CHECK is
-- REPLACED rather than added — it gains a third conjunct — and the new conjunct
-- is vacuous for every row the old image can produce, because it only says a
-- faircoin intent's charge id is null and the old image never sets one.
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_faircoin_has_no_provider_check";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "provider_charge_id" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_faircoin_has_no_provider_check" CHECK ("payment_intents"."rail" <> 'faircoin' or ("payment_intents"."provider" is null and "payment_intents"."provider_object_id" is null and "payment_intents"."provider_charge_id" is null));
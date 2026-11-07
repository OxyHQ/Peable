-- oxy:deploy-phase=pre
-- Terminal (ADR 0024), part 3 of 4: a card-rail PaymentIntent may carry
-- `card_present` (collected by a reader). payment_intents is hot, so this sits
-- alone and the widened CHECK is added NOT VALID; 0129 validates it.
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_payment_method_types_check";--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_method_types_check" CHECK (payment_method_types is null or (cardinality(payment_method_types) >= 1 and payment_method_types <@ ARRAY['card', 'sepa_debit', 'ideal', 'bancontact', 'eps', 'card_present']::text[])) NOT VALID;

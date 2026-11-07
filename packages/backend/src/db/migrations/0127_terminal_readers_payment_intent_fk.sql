-- oxy:deploy-phase=pre
-- Terminal (ADR 0024), part 2 of 4: the reader's action names a payment. A
-- foreign key REFERENCING payment_intents locks it (SHARE ROW EXCLUSIVE), so it
-- sits alone, added NOT VALID; 0129 validates it.
ALTER TABLE "terminal_readers" ADD CONSTRAINT "terminal_readers_action_payment_intent_fkey" FOREIGN KEY ("action_payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action NOT VALID;

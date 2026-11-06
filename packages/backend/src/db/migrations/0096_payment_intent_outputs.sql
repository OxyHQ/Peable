-- oxy:deploy-phase=pre
-- ADR 0021 D6: a FairCoin payment's outputs — one row per seller (or the
-- merchant's owner) its ONE transaction pays. A new table (its references to
-- payment_intents, merchants and connected_accounts are added while it is empty);
-- a Checkout Session line may name its seller. The line's reference to the hot
-- connected_accounts is NOT VALID here and validated in 0098 (post).
CREATE TABLE "payment_intent_outputs" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_intent_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"position" integer NOT NULL,
	"connected_account_id" text,
	"network" text NOT NULL,
	"recipient_account_id" text NOT NULL,
	"address" text NOT NULL,
	"amount" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payment_intent_outputs_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$' and amount <> '0'),
	CONSTRAINT "payment_intent_outputs_position_check" CHECK ("payment_intent_outputs"."position" >= 0),
	CONSTRAINT "payment_intent_outputs_network_check" CHECK (network in ('mainnet', 'testnet'))
);
--> statement-breakpoint
ALTER TABLE "checkout_session_line_items" ADD COLUMN "connected_account_id" text;--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" ADD CONSTRAINT "payment_intent_outputs_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" ADD CONSTRAINT "payment_intent_outputs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intent_outputs" ADD CONSTRAINT "payment_intent_outputs_connected_account_network_fkey" FOREIGN KEY ("connected_account_id","merchant_id","network") REFERENCES "public"."connected_accounts"("id","merchant_id","network") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intent_outputs_intent_position_key" ON "payment_intent_outputs" USING btree ("payment_intent_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intent_outputs_network_address_key" ON "payment_intent_outputs" USING btree ("network","address");--> statement-breakpoint
ALTER TABLE "checkout_session_line_items" ADD CONSTRAINT "checkout_session_line_items_connected_account_fkey" FOREIGN KEY ("connected_account_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action NOT VALID;

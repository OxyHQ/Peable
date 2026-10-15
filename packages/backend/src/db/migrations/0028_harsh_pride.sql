-- oxy:deploy-phase=pre
CREATE TABLE "faircoin_billing_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"checkout_ref" text NOT NULL,
	"operation_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"tax_snapshot" jsonb NOT NULL,
	"fx_quote" jsonb NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"payment_intent_id" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "faircoin_billing_invoices_checkoutRef_unique" UNIQUE("checkout_ref"),
	CONSTRAINT "faircoin_billing_invoices_paymentIntentId_unique" UNIQUE("payment_intent_id"),
	CONSTRAINT "faircoin_billing_invoice_operation" UNIQUE("subscription_id","operation_key"),
	CONSTRAINT "faircoin_billing_invoice_period" UNIQUE("subscription_id","period_start"),
	CONSTRAINT "faircoin_billing_positive_period" CHECK ("faircoin_billing_invoices"."period_end" > "faircoin_billing_invoices"."period_start"),
	CONSTRAINT "faircoin_billing_usd_quote" CHECK ("faircoin_billing_invoices"."fx_quote"->>'currency' = 'USD')
);
--> statement-breakpoint
CREATE TABLE "faircoin_billing_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"oxy_app_id" text NOT NULL,
	"environment" text NOT NULL,
	"subject_ref" text NOT NULL,
	"plan_ref" text NOT NULL,
	"price_ref" text NOT NULL,
	"customer_ref" text NOT NULL,
	"initial_key" text NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "faircoin_billing_initial_key" UNIQUE("merchant_id","initial_key")
);
--> statement-breakpoint
ALTER TABLE "faircoin_billing_invoices" ADD CONSTRAINT "faircoin_billing_invoices_subscription_id_faircoin_billing_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."faircoin_billing_subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faircoin_billing_invoices" ADD CONSTRAINT "faircoin_billing_invoices_payment_intent_id_payment_intents_id_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faircoin_billing_subscriptions" ADD CONSTRAINT "faircoin_billing_owner_fk" FOREIGN KEY ("merchant_id","oxy_app_id","environment") REFERENCES "public"."merchants"("id","oxy_app_id","environment") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "faircoin_billing_live_subject_plan" ON "faircoin_billing_subscriptions" USING btree ("merchant_id","subject_ref","plan_ref") WHERE "faircoin_billing_subscriptions"."cancel_at_period_end" = false;
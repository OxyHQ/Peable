-- oxy:deploy-phase=pre
-- The Stripe-Billing proxy migration's record (ADR 0018 §7): one new, empty
-- table. Its foreign keys onto existing tables validate against zero rows and
-- touch no hot table (merchants is reached through customers' composite key).
CREATE TABLE "billing_proxy_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"subscription_binding_id" text NOT NULL,
	"customer_binding_id" text NOT NULL,
	"provider_subscription_ref" text NOT NULL,
	"customer_id" text NOT NULL,
	"payment_method_id" text NOT NULL,
	"price_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"state" text NOT NULL,
	"adopted_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_proxy_migrations_subscription_binding_key" UNIQUE("subscription_binding_id"),
	CONSTRAINT "billing_proxy_migrations_subscription_key" UNIQUE("subscription_id"),
	CONSTRAINT "billing_proxy_migrations_state_check" CHECK (state in ('adopted', 'released')),
	CONSTRAINT "billing_proxy_migrations_released_check" CHECK ((state = 'released') = (released_at is not null))
);
--> statement-breakpoint
ALTER TABLE "billing_proxy_migrations" ADD CONSTRAINT "billing_proxy_migrations_subscription_binding_id_billing_object_bindings_id_fk" FOREIGN KEY ("subscription_binding_id") REFERENCES "public"."billing_object_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_proxy_migrations" ADD CONSTRAINT "billing_proxy_migrations_customer_binding_id_billing_object_bindings_id_fk" FOREIGN KEY ("customer_binding_id") REFERENCES "public"."billing_object_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_proxy_migrations" ADD CONSTRAINT "billing_proxy_migrations_customer_fkey" FOREIGN KEY ("customer_id","merchant_id") REFERENCES "public"."customers"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_proxy_migrations" ADD CONSTRAINT "billing_proxy_migrations_payment_method_fkey" FOREIGN KEY ("payment_method_id","customer_id") REFERENCES "public"."payment_methods"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_proxy_migrations" ADD CONSTRAINT "billing_proxy_migrations_price_fkey" FOREIGN KEY ("price_id","merchant_id") REFERENCES "public"."prices"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_proxy_migrations" ADD CONSTRAINT "billing_proxy_migrations_subscription_fkey" FOREIGN KEY ("subscription_id","customer_id") REFERENCES "public"."subscriptions"("id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_proxy_migrations_customer_binding_idx" ON "billing_proxy_migrations" USING btree ("customer_binding_id");--> statement-breakpoint
CREATE INDEX "billing_proxy_migrations_merchant_state_idx" ON "billing_proxy_migrations" USING btree ("merchant_id","state");
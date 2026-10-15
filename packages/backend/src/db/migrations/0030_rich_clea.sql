-- oxy:deploy-phase=pre
ALTER TABLE "faircoin_billing_subscriptions" ADD COLUMN "billing_interval" text DEFAULT 'month' NOT NULL;--> statement-breakpoint
ALTER TABLE "faircoin_billing_subscriptions" ADD CONSTRAINT "faircoin_billing_interval" CHECK ("faircoin_billing_subscriptions"."billing_interval" IN ('month', 'year'));
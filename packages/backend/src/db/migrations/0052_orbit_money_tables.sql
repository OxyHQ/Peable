-- oxy:deploy-phase=pre
-- ADR 0015 — Orbit money, the new tables (fees, application fees, payouts, the
-- ledger, reconciliation) plus the refund fields and the widened event catalog.
-- Hand edits: the constraints re-added on the EXISTING tables `events`,
-- `webhook_endpoints` and `refunds` are `NOT VALID` (validated by the last,
-- post migration of this set); every other statement is drizzle-kit's.
CREATE TABLE "application_fee_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"application_fee_id" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_fee_refunds_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "application_fee_refunds_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "application_fee_refunds_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "application_fee_refunds_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$' and amount <> '0')
);
--> statement-breakpoint
CREATE TABLE "application_fees" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "application_fees_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "application_fees_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "application_fees_payment_intent_id_key" UNIQUE("payment_intent_id"),
	CONSTRAINT "application_fees_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "application_fees_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "application_fees_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "application_fees_currency_check" CHECK (currency ~ '^[A-Z]{3,4}$')
);
--> statement-breakpoint
CREATE TABLE "balance_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"connected_account_id" text,
	"ingestion_key" text NOT NULL,
	"provider" text,
	"provider_object_id" text,
	"amount" text NOT NULL,
	"fee" text,
	"net" text,
	"currency" text NOT NULL,
	"type" text NOT NULL,
	"reporting_category" text NOT NULL,
	"status" text NOT NULL,
	"available_on" timestamp with time zone,
	"occurred_at" timestamp with time zone NOT NULL,
	"description" text,
	"exchange_rate" text,
	"fee_details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_type" text,
	"source_id" text,
	"payment_intent_id" text,
	"payout_id" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "balance_transactions_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "balance_transactions_ingestion_key_key" UNIQUE("ingestion_key"),
	CONSTRAINT "balance_transactions_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "balance_transactions_provider_check" CHECK (provider is null or provider in ('stripe')),
	CONSTRAINT "balance_transactions_type_check" CHECK (type in ('charge', 'payment', 'refund', 'payment_refund', 'adjustment', 'application_fee', 'application_fee_refund', 'payout', 'payout_cancel', 'payout_failure', 'transfer', 'transfer_refund', 'dispute', 'dispute_reversal', 'processing_fee', 'faircoin_payment', 'faircoin_payment_reversal', 'other')),
	CONSTRAINT "balance_transactions_status_check" CHECK (status in ('available', 'pending', 'informational')),
	CONSTRAINT "balance_transactions_amounts_check" CHECK (amount ~ '^(0|-?[1-9][0-9]*)$' and (fee is null or fee ~ '^(0|-?[1-9][0-9]*)$') and (net is null or net ~ '^(0|-?[1-9][0-9]*)$')),
	CONSTRAINT "balance_transactions_net_agrees_check" CHECK (("balance_transactions"."fee" is null) = ("balance_transactions"."net" is null)
          and ("balance_transactions"."fee" is null or "balance_transactions"."amount"::numeric - "balance_transactions"."fee"::numeric = "balance_transactions"."net"::numeric)),
	CONSTRAINT "balance_transactions_currency_check" CHECK (currency ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "balance_transactions_provider_fields_agree_check" CHECK (("balance_transactions"."provider" is null) = ("balance_transactions"."provider_object_id" is null)),
	CONSTRAINT "balance_transactions_informational_agrees_check" CHECK (("balance_transactions"."status" = 'informational')
          = ("balance_transactions"."type" in ('faircoin_payment', 'faircoin_payment_reversal'))
          and ("balance_transactions"."status" = 'informational') = ("balance_transactions"."provider" is null)),
	CONSTRAINT "balance_transactions_source_agrees_check" CHECK (("balance_transactions"."source_type" is null) = ("balance_transactions"."source_id" is null))
);
--> statement-breakpoint
CREATE TABLE "fee_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"payment_method_type" text NOT NULL,
	"currency" text NOT NULL,
	"percent_bps" integer NOT NULL,
	"fixed_amount" text DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "fee_schedules_merchant_method_currency_key" UNIQUE("merchant_id","payment_method_type","currency"),
	CONSTRAINT "fee_schedules_payment_method_type_check" CHECK (payment_method_type in ('card')),
	CONSTRAINT "fee_schedules_currency_check" CHECK (currency in ('FAIR', 'EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'CAD', 'AUD', 'JPY')),
	CONSTRAINT "fee_schedules_percent_bps_check" CHECK ("fee_schedules"."percent_bps" >= 0 and "fee_schedules"."percent_bps" <= 10000),
	CONSTRAINT "fee_schedules_fixed_amount_check" CHECK (fixed_amount ~ '^(0|[1-9][0-9]*)$')
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"journal_id" text NOT NULL,
	"kind" text NOT NULL,
	"balance_transaction_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"connected_account_id" text,
	"currency" text NOT NULL,
	"balance_type" text NOT NULL,
	"amount" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "ledger_entries_transaction_kind_balance_type_key" UNIQUE("balance_transaction_id","kind","balance_type"),
	CONSTRAINT "ledger_entries_kind_check" CHECK (kind in ('recognized', 'released')),
	CONSTRAINT "ledger_entries_balance_type_check" CHECK (balance_type in ('available', 'pending', 'informational', 'external')),
	CONSTRAINT "ledger_entries_amount_check" CHECK (amount ~ '^(0|-?[1-9][0-9]*)$' and amount <> '0'),
	CONSTRAINT "ledger_entries_currency_check" CHECK (currency ~ '^[A-Z]{3,4}$')
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"connected_account_id" text NOT NULL,
	"origin" text NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text,
	"amount" text NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"method" text DEFAULT 'standard' NOT NULL,
	"type" text DEFAULT 'bank_account' NOT NULL,
	"automatic" boolean NOT NULL,
	"arrival_date" timestamp with time zone,
	"description" text,
	"statement_descriptor" text,
	"failure_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider_created_at" timestamp with time zone,
	"transactions_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "payouts_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "payouts_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "payouts_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "payouts_origin_check" CHECK (origin in ('provider', 'merchant')),
	CONSTRAINT "payouts_status_check" CHECK (status in ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
	CONSTRAINT "payouts_method_check" CHECK (method in ('standard', 'instant')),
	CONSTRAINT "payouts_type_check" CHECK (type in ('bank_account', 'card')),
	CONSTRAINT "payouts_amount_check" CHECK (amount ~ '^(0|[1-9][0-9]*)$'),
	CONSTRAINT "payouts_currency_check" CHECK (currency ~ '^[A-Z]{3,4}$'),
	CONSTRAINT "payouts_provider_origin_has_object_check" CHECK ("payouts"."origin" <> 'provider' or "payouts"."provider_object_id" is not null),
	CONSTRAINT "payouts_automatic_agrees_check" CHECK ("payouts"."automatic" = ("payouts"."origin" = 'provider'))
);
--> statement-breakpoint
CREATE TABLE "reconciliation_mismatches" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"connected_account_id" text,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"object_public_id" text,
	"expected" jsonb,
	"actual" jsonb,
	"detected_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "reconciliation_mismatches_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "reconciliation_mismatches_kind_check" CHECK (kind in ('missing_in_ledger', 'amount_mismatch', 'status_mismatch', 'missing_at_provider', 'payout_mismatch', 'unbalanced_journal'))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_status_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "refund_application_fee" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "refunds" ADD COLUMN "reverse_transfer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "application_fee_refunds" ADD CONSTRAINT "application_fee_refunds_application_fee_id_fkey" FOREIGN KEY ("application_fee_id") REFERENCES "public"."application_fees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_fees" ADD CONSTRAINT "application_fees_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_fees" ADD CONSTRAINT "application_fees_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_fees" ADD CONSTRAINT "application_fees_connected_account_merchant_fkey" FOREIGN KEY ("connected_account_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_connected_account_merchant_fkey" FOREIGN KEY ("connected_account_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "balance_transactions" ADD CONSTRAINT "balance_transactions_payout_merchant_fkey" FOREIGN KEY ("payout_id","merchant_id") REFERENCES "public"."payouts"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_schedules" ADD CONSTRAINT "fee_schedules_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_balance_transaction_merchant_fkey" FOREIGN KEY ("balance_transaction_id","merchant_id") REFERENCES "public"."balance_transactions"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_connected_account_merchant_fkey" FOREIGN KEY ("connected_account_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_connected_account_merchant_fkey" FOREIGN KEY ("connected_account_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_mismatches" ADD CONSTRAINT "reconciliation_mismatches_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_mismatches" ADD CONSTRAINT "reconciliation_mismatches_connected_account_merchant_fkey" FOREIGN KEY ("connected_account_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_fee_refunds_application_fee_id_idx" ON "application_fee_refunds" USING btree ("application_fee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "balance_transactions_provider_object_key" ON "balance_transactions" USING btree ("provider","provider_object_id") WHERE "balance_transactions"."provider_object_id" is not null;--> statement-breakpoint
CREATE INDEX "balance_transactions_merchant_account_idx" ON "balance_transactions" USING btree ("merchant_id","connected_account_id","occurred_at");--> statement-breakpoint
CREATE INDEX "balance_transactions_payout_id_idx" ON "balance_transactions" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "balance_transactions_source_idx" ON "balance_transactions" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("merchant_id","connected_account_id","currency","balance_type");--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_id_idx" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_provider_object_key" ON "payouts" USING btree ("provider","provider_object_id") WHERE "payouts"."provider_object_id" is not null;--> statement-breakpoint
CREATE INDEX "payouts_connected_account_id_idx" ON "payouts" USING btree ("connected_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_mismatches_open_key" ON "reconciliation_mismatches" USING btree ("kind","subject") WHERE "reconciliation_mismatches"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "reconciliation_mismatches_merchant_idx" ON "reconciliation_mismatches" USING btree ("merchant_id","resolved_at");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_reason_check" CHECK (reason is null or reason in ('duplicate', 'fraudulent', 'requested_by_customer')) NOT VALID;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_check" CHECK (status in ('pending', 'succeeded', 'failed', 'canceled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'billing.observation.updated', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available']::text[]) NOT VALID;

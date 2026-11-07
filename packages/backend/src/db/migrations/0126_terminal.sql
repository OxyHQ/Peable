-- oxy:deploy-phase=pre
-- Terminal (ADR 0024), part 1 of 4: terminal_locations and terminal_readers
-- (each bound to its provider object; a reader's one action, CAS-written), and
-- the two terminal.reader.action_* event types. The widened events and
-- webhook_endpoints CHECKs are added NOT VALID; 0129 validates them.
CREATE TABLE "terminal_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"address" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "terminal_locations_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "terminal_locations_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "terminal_locations_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "terminal_locations_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "terminal_locations_address_country_check" CHECK (jsonb_typeof("terminal_locations"."address") = 'object' and "terminal_locations"."address" ->> 'country' ~ '^[A-Z]{2}$'),
	CONSTRAINT "terminal_locations_metadata_object_check" CHECK (jsonb_typeof("terminal_locations"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "terminal_readers" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"location_id" text NOT NULL,
	"label" text NOT NULL,
	"device_type" text NOT NULL,
	"serial_number" text NOT NULL,
	"status" text,
	"last_seen_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"action_type" text,
	"action_status" text,
	"action_payment_intent_id" text,
	"action_enable_customer_cancellation" boolean,
	"action_failure_code" text,
	"action_started_at" timestamp with time zone,
	"action_acknowledged_at" timestamp with time zone,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "terminal_readers_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "terminal_readers_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "terminal_readers_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "terminal_readers_status_check" CHECK (status is null or status in ('online', 'offline')),
	CONSTRAINT "terminal_readers_metadata_object_check" CHECK (jsonb_typeof("terminal_readers"."metadata") = 'object'),
	CONSTRAINT "terminal_readers_action_shape_check" CHECK ((action_type is null and action_status is null and action_payment_intent_id is null and action_enable_customer_cancellation is null and action_failure_code is null and action_started_at is null and action_acknowledged_at is null) or (action_type in ('process_payment_intent') and action_status in ('in_progress', 'succeeded', 'failed') and action_payment_intent_id is not null and action_enable_customer_cancellation is not null and action_started_at is not null and (action_failure_code is null or action_status = 'failed')))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "terminal_locations" ADD CONSTRAINT "terminal_locations_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_readers" ADD CONSTRAINT "terminal_readers_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminal_readers" ADD CONSTRAINT "terminal_readers_location_merchant_fkey" FOREIGN KEY ("location_id","merchant_id") REFERENCES "public"."terminal_locations"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "terminal_locations_merchant_id_idx" ON "terminal_locations" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "terminal_readers_merchant_id_idx" ON "terminal_readers" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "terminal_readers_location_id_idx" ON "terminal_readers" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "terminal_readers_action_payment_intent_id_idx" ON "terminal_readers" USING btree ("action_payment_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "terminal_readers_collecting_intent_key" ON "terminal_readers" USING btree ("action_payment_intent_id") WHERE "terminal_readers"."action_status" = 'in_progress';--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'quote.created', 'quote.finalized', 'quote.accepted', 'quote.canceled', 'review.opened', 'review.closed', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated', 'identity.verification_session.created', 'identity.verification_session.processing', 'identity.verification_session.verified', 'identity.verification_session.requires_input', 'identity.verification_session.canceled', 'identity.verification_session.redacted', 'terminal.reader.action_succeeded', 'terminal.reader.action_failed', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'quote.created', 'quote.finalized', 'quote.accepted', 'quote.canceled', 'review.opened', 'review.closed', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated', 'identity.verification_session.created', 'identity.verification_session.processing', 'identity.verification_session.verified', 'identity.verification_session.requires_input', 'identity.verification_session.canceled', 'identity.verification_session.redacted', 'terminal.reader.action_succeeded', 'terminal.reader.action_failed']::text[]) NOT VALID;
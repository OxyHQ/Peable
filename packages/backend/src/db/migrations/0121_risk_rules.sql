-- oxy:deploy-phase=pre
-- Risk rules (ADR 0022), part 1 of 5: the `radar_rules`, `radar_evaluations`
-- and `reviews` tables, `charges.radar_evaluated_at` (the post-authorization
-- judgment's once-per-charge claim) and `charges.radar_judge_attempted_at`
-- (the judge sweep's backoff) — both nullable, no default: no rewrite — and the
-- event catalog widened for review.opened / review.closed. Additive for the
-- image still serving: nothing it reads changes.
-- HAND EDIT: the three CHECKs re-added to existing tables (events,
-- webhook_endpoints) are NOT VALID, so none scans under ACCESS EXCLUSIVE; the
-- post migration (0125) validates them under SHARE UPDATE EXCLUSIVE. Each only
-- widens its set, so every existing row already satisfies it. The backfill of
-- the new column is its own migration (0122), so nothing here holds a lock
-- while a table is scanned.
CREATE TABLE "radar_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"phase" text NOT NULL,
	"decision" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_version" integer NOT NULL,
	"rule_predicate" text NOT NULL,
	"facts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "radar_evaluations_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "radar_evaluations_phase_check" CHECK (phase in ('pre_authorization', 'post_authorization')),
	CONSTRAINT "radar_evaluations_decision_check" CHECK (decision in ('allow', 'block', 'review')),
	CONSTRAINT "radar_evaluations_facts_object_check" CHECK (jsonb_typeof("radar_evaluations"."facts") = 'object')
);
--> statement-breakpoint
CREATE TABLE "radar_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"action" text NOT NULL,
	"predicate" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "radar_rules_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "radar_rules_action_check" CHECK (action in ('allow', 'block', 'review')),
	CONSTRAINT "radar_rules_predicate_length_check" CHECK (length(predicate) between 1 and 1000),
	CONSTRAINT "radar_rules_description_length_check" CHECK (description is null or length(description) between 1 and 500),
	CONSTRAINT "radar_rules_version_check" CHECK ("radar_rules"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"payment_intent_id" text NOT NULL,
	"opened_reason" text DEFAULT 'rule' NOT NULL,
	"closed_reason" text,
	"pending_closed_reason" text,
	"pending_closed_until" timestamp with time zone,
	"rule_id" text,
	"rule_version" integer,
	"rule_action" text,
	"rule_predicate" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "reviews_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "reviews_payment_intent_id_key" UNIQUE("payment_intent_id"),
	CONSTRAINT "reviews_opened_reason_check" CHECK (opened_reason in ('rule')),
	CONSTRAINT "reviews_closed_reason_check" CHECK (closed_reason is null or closed_reason in ('approved', 'refunded', 'refunded_as_fraud', 'canceled', 'disputed')),
	CONSTRAINT "reviews_pending_closed_reason_check" CHECK (pending_closed_reason is null or pending_closed_reason in ('approved', 'refunded', 'refunded_as_fraud', 'canceled', 'disputed')),
	CONSTRAINT "reviews_closed_shape_check" CHECK (("reviews"."closed_reason" is null) = ("reviews"."closed_at" is null) and ("reviews"."closed_reason" is null or "reviews"."pending_closed_reason" is null) and ("reviews"."pending_closed_until" is null or "reviews"."pending_closed_reason" is not null)),
	CONSTRAINT "reviews_rule_shape_check" CHECK (("reviews"."rule_id" is null) = ("reviews"."rule_version" is null) and ("reviews"."rule_id" is null) = ("reviews"."rule_action" is null) and ("reviews"."rule_id" is null) = ("reviews"."rule_predicate" is null))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_intent_event_has_intent_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "radar_evaluated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "charges" ADD COLUMN "radar_judge_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD CONSTRAINT "radar_evaluations_merchant_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radar_evaluations" ADD CONSTRAINT "radar_evaluations_payment_intent_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "radar_rules" ADD CONSTRAINT "radar_rules_merchant_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_merchant_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_payment_intent_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "radar_evaluations_merchant_id_id_idx" ON "radar_evaluations" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "radar_evaluations_payment_intent_id_idx" ON "radar_evaluations" USING btree ("payment_intent_id");--> statement-breakpoint
CREATE INDEX "radar_rules_merchant_id_id_idx" ON "radar_rules" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "reviews_merchant_id_id_idx" ON "reviews" USING btree ("merchant_id","id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'quote.created', 'quote.finalized', 'quote.accepted', 'quote.canceled', 'review.opened', 'review.closed', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated', 'identity.verification_session.created', 'identity.verification_session.processing', 'identity.verification_session.verified', 'identity.verification_session.requires_input', 'identity.verification_session.canceled', 'identity.verification_session.redacted', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_intent_event_has_intent_check" CHECK ((type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'review.opened', 'review.closed')) = (payment_intent_id is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'quote.created', 'quote.finalized', 'quote.accepted', 'quote.canceled', 'review.opened', 'review.closed', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated', 'identity.verification_session.created', 'identity.verification_session.processing', 'identity.verification_session.verified', 'identity.verification_session.requires_input', 'identity.verification_session.canceled', 'identity.verification_session.redacted']::text[]) NOT VALID;
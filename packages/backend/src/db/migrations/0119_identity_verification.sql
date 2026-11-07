-- oxy:deploy-phase=pre
-- Identity verification (ADR 0023), part 1 of 2: verification_sessions and
-- verification_reports (outcomes only, never the person's data), and the six
-- identity.verification_session.* event types. The widened events and
-- webhook_endpoints CHECKs are added NOT VALID; 0120 validates them.
CREATE TABLE "verification_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"verification_session_id" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb NOT NULL,
	"document_status" text,
	"document_error_code" text,
	"id_number_status" text,
	"id_number_error_code" text,
	"selfie_status" text,
	"selfie_error_code" text,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "verification_reports_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "verification_reports_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "verification_reports_type_check" CHECK (type in ('document', 'id_number')),
	CONSTRAINT "verification_reports_check_status_check" CHECK ((document_status is null or document_status in ('verified', 'unverified')) and (id_number_status is null or id_number_status in ('verified', 'unverified')) and (selfie_status is null or selfie_status in ('verified', 'unverified'))),
	CONSTRAINT "verification_reports_error_code_check" CHECK ((document_error_code is null or (document_status = 'unverified' and document_error_code in ('abandoned', 'consent_declined', 'country_not_supported', 'device_not_supported', 'document_expired', 'document_type_not_supported', 'document_unverified_other', 'email_unverified_other', 'email_verification_declined', 'id_number_insufficient_document_data', 'id_number_mismatch', 'id_number_unverified_other', 'phone_unverified_other', 'phone_verification_declined', 'selfie_document_missing_photo', 'selfie_face_mismatch', 'selfie_manipulated', 'selfie_unverified_other', 'under_supported_age'))) and (id_number_error_code is null or (id_number_status = 'unverified' and id_number_error_code in ('abandoned', 'consent_declined', 'country_not_supported', 'device_not_supported', 'document_expired', 'document_type_not_supported', 'document_unverified_other', 'email_unverified_other', 'email_verification_declined', 'id_number_insufficient_document_data', 'id_number_mismatch', 'id_number_unverified_other', 'phone_unverified_other', 'phone_verification_declined', 'selfie_document_missing_photo', 'selfie_face_mismatch', 'selfie_manipulated', 'selfie_unverified_other', 'under_supported_age'))) and (selfie_error_code is null or (selfie_status = 'unverified' and selfie_error_code in ('abandoned', 'consent_declined', 'country_not_supported', 'device_not_supported', 'document_expired', 'document_type_not_supported', 'document_unverified_other', 'email_unverified_other', 'email_verification_declined', 'id_number_insufficient_document_data', 'id_number_mismatch', 'id_number_unverified_other', 'phone_unverified_other', 'phone_verification_declined', 'selfie_document_missing_photo', 'selfie_face_mismatch', 'selfie_manipulated', 'selfie_unverified_other', 'under_supported_age')))),
	CONSTRAINT "verification_reports_provider_check" CHECK (provider in ('stripe'))
);
--> statement-breakpoint
CREATE TABLE "verification_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'requires_input' NOT NULL,
	"options" jsonb NOT NULL,
	"return_url" text,
	"client_reference_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error_code" text,
	"has_last_error" boolean DEFAULT false NOT NULL,
	"redaction_status" text,
	"provider" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "verification_sessions_public_id_key" UNIQUE("public_id"),
	CONSTRAINT "verification_sessions_id_merchant_id_key" UNIQUE("id","merchant_id"),
	CONSTRAINT "verification_sessions_provider_object_key" UNIQUE("provider","provider_object_id"),
	CONSTRAINT "verification_sessions_type_check" CHECK (type in ('document', 'id_number')),
	CONSTRAINT "verification_sessions_status_check" CHECK (status in ('requires_input', 'processing', 'verified', 'canceled')),
	CONSTRAINT "verification_sessions_last_error_code_check" CHECK (last_error_code is null or last_error_code in ('abandoned', 'consent_declined', 'country_not_supported', 'device_not_supported', 'document_expired', 'document_type_not_supported', 'document_unverified_other', 'email_unverified_other', 'email_verification_declined', 'id_number_insufficient_document_data', 'id_number_mismatch', 'id_number_unverified_other', 'phone_unverified_other', 'phone_verification_declined', 'selfie_document_missing_photo', 'selfie_face_mismatch', 'selfie_manipulated', 'selfie_unverified_other', 'under_supported_age')),
	CONSTRAINT "verification_sessions_last_error_check" CHECK ("verification_sessions"."last_error_code" is null or "verification_sessions"."has_last_error"),
	CONSTRAINT "verification_sessions_redaction_status_check" CHECK (redaction_status is null or redaction_status in ('processing', 'redacted')),
	CONSTRAINT "verification_sessions_provider_check" CHECK (provider in ('stripe')),
	CONSTRAINT "verification_sessions_metadata_object_check" CHECK (jsonb_typeof("verification_sessions"."metadata") = 'object'),
	CONSTRAINT "verification_sessions_options_object_check" CHECK (jsonb_typeof("verification_sessions"."options") = 'object'),
	CONSTRAINT "verification_sessions_redacted_holds_no_reference_check" CHECK ("verification_sessions"."redaction_status" is null or ("verification_sessions"."metadata" = '{}'::jsonb and "verification_sessions"."client_reference_id" is null))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_type_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_enabled_events_check";--> statement-breakpoint
ALTER TABLE "verification_reports" ADD CONSTRAINT "verification_reports_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_reports" ADD CONSTRAINT "verification_reports_session_merchant_fkey" FOREIGN KEY ("verification_session_id","merchant_id") REFERENCES "public"."verification_sessions"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_sessions" ADD CONSTRAINT "verification_sessions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verification_reports_merchant_id_idx" ON "verification_reports" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "verification_reports_session_id_idx" ON "verification_reports" USING btree ("verification_session_id");--> statement-breakpoint
CREATE INDEX "verification_sessions_merchant_id_idx" ON "verification_sessions" USING btree ("merchant_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_type_check" CHECK (type in ('payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'quote.created', 'quote.finalized', 'quote.accepted', 'quote.canceled', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated', 'identity.verification_session.created', 'identity.verification_session.processing', 'identity.verification_session.verified', 'identity.verification_session.requires_input', 'identity.verification_session.canceled', 'identity.verification_session.redacted', 'webhook_endpoint.test')) NOT VALID;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_enabled_events_check" CHECK (cardinality(enabled_events) >= 1 and enabled_events <@ ARRAY['*', 'payment_intent.created', 'payment_intent.requires_action', 'payment_intent.processing', 'payment_intent.amount_capturable_updated', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'payment_intent.canceled', 'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated', 'charge.dispute.closed', 'charge.dispute.funds_withdrawn', 'charge.dispute.funds_reinstated', 'refund.created', 'refund.updated', 'refund.failed', 'customer.created', 'customer.updated', 'customer.deleted', 'payment_method.attached', 'payment_method.detached', 'payment_method.updated', 'setup_intent.created', 'setup_intent.requires_action', 'setup_intent.succeeded', 'setup_intent.setup_failed', 'setup_intent.canceled', 'connected_account.updated', 'product.created', 'product.updated', 'product.deleted', 'price.created', 'price.updated', 'coupon.created', 'coupon.updated', 'coupon.deleted', 'promotion_code.created', 'promotion_code.updated', 'account.updated', 'application_fee.created', 'application_fee.refunded', 'payout.created', 'payout.updated', 'payout.paid', 'payout.failed', 'payout.canceled', 'balance.available', 'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'payment_link.created', 'payment_link.updated', 'reporting.report_run.succeeded', 'reporting.report_run.failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.trial_will_end', 'customer.subscription.paused', 'customer.subscription.resumed', 'invoice.created', 'invoice.updated', 'invoice.deleted', 'invoice.finalized', 'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible', 'invoice.upcoming', 'invoice.sent', 'invoiceitem.created', 'invoiceitem.deleted', 'credit_note.created', 'credit_note.updated', 'credit_note.voided', 'test_helpers.test_clock.created', 'test_helpers.test_clock.advancing', 'test_helpers.test_clock.ready', 'test_helpers.test_clock.deleted', 'billing.meter.created', 'billing.meter.updated', 'billing.meter.deactivated', 'billing.meter.reactivated', 'entitlements.active_entitlement_summary.updated', 'billing_portal.configuration.created', 'billing_portal.configuration.updated', 'billing_portal.session.created', 'quote.created', 'quote.finalized', 'quote.accepted', 'quote.canceled', 'tax.assessment.created', 'tax.review_item.created', 'tax.review_item.updated', 'identity.verification_session.created', 'identity.verification_session.processing', 'identity.verification_session.verified', 'identity.verification_session.requires_input', 'identity.verification_session.canceled', 'identity.verification_session.redacted']::text[]) NOT VALID;
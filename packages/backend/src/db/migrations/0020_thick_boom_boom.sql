-- oxy:deploy-phase=pre
CREATE TABLE "billing_object_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"oxy_app_id" text NOT NULL,
	"environment" text NOT NULL,
	"provider" text NOT NULL,
	"platform_account_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"kind" text NOT NULL,
	"provider_ref" text NOT NULL,
	"external_subject_ref" text,
	"plan_ref" text,
	"customer_binding_id" text,
	"price_binding_id" text,
	"binding_evidence_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "billing_bindings_provider_object_key" UNIQUE("provider","platform_account_id","livemode","kind","provider_ref"),
	CONSTRAINT "billing_bindings_provider_check" CHECK ("billing_object_bindings"."provider" = 'stripe'),
	CONSTRAINT "billing_bindings_kind_check" CHECK (kind in ('customer', 'price', 'subscription')),
	CONSTRAINT "billing_bindings_mode_check" CHECK (("billing_object_bindings"."environment" = 'production') = "billing_object_bindings"."livemode"),
	CONSTRAINT "billing_bindings_shape_check" CHECK (("billing_object_bindings"."kind" = 'customer' and "billing_object_bindings"."external_subject_ref" is not null and "billing_object_bindings"."plan_ref" is null and "billing_object_bindings"."customer_binding_id" is null and "billing_object_bindings"."price_binding_id" is null) or ("billing_object_bindings"."kind" = 'price' and "billing_object_bindings"."external_subject_ref" is null and "billing_object_bindings"."plan_ref" is not null and "billing_object_bindings"."customer_binding_id" is null and "billing_object_bindings"."price_binding_id" is null) or ("billing_object_bindings"."kind" = 'subscription' and "billing_object_bindings"."external_subject_ref" is not null and "billing_object_bindings"."plan_ref" is not null and "billing_object_bindings"."customer_binding_id" is not null and "billing_object_bindings"."price_binding_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "billing_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"oxy_app_id" text NOT NULL,
	"environment" text NOT NULL,
	"provider" text NOT NULL,
	"platform_account_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"subject_claim_ref" text,
	"remote_idempotency_key" text NOT NULL,
	"customer_binding_id" text,
	"price_binding_id" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_token" text,
	"lease_expires_at" timestamp with time zone,
	"retry_until" timestamp with time zone NOT NULL,
	"result" jsonb,
	"result_expires_at" timestamp with time zone,
	"provider_object_ref" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "billing_operations_global_key" UNIQUE("provider","platform_account_id","livemode","idempotency_key"),
	CONSTRAINT "billing_operations_checkout_bindings_check" CHECK (("billing_operations"."operation" = 'checkout' and "billing_operations"."customer_binding_id" is not null and "billing_operations"."price_binding_id" is not null) or ("billing_operations"."operation" <> 'checkout' and "billing_operations"."customer_binding_id" is null and "billing_operations"."price_binding_id" is null)),
	CONSTRAINT "billing_operations_checkout_result_check" CHECK ("billing_operations"."operation" <> 'checkout' or "billing_operations"."state" <> 'succeeded' or "billing_operations"."provider_object_ref" is not null),
	CONSTRAINT "billing_operations_provider_check" CHECK ("billing_operations"."provider" = 'stripe'),
	CONSTRAINT "billing_operations_operation_check" CHECK (operation in ('ensure_customer', 'checkout', 'portal', 'cancel_at_period_end')),
	CONSTRAINT "billing_operations_state_check" CHECK (state in ('pending', 'succeeded', 'indeterminate')),
	CONSTRAINT "billing_operations_mode_check" CHECK (("billing_operations"."environment" = 'production') = "billing_operations"."livemode"),
	CONSTRAINT "billing_operations_digest_check" CHECK ("billing_operations"."request_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "billing_operations_subject_check" CHECK (("billing_operations"."operation" = 'ensure_customer') = ("billing_operations"."subject_claim_ref" is not null)),
	CONSTRAINT "billing_operations_lease_check" CHECK (("billing_operations"."lease_token" is null) = ("billing_operations"."lease_expires_at" is null)),
	CONSTRAINT "billing_operations_result_check" CHECK (("billing_operations"."state" = 'succeeded' and "billing_operations"."result" is not null and jsonb_typeof("billing_operations"."result") = 'object' and "billing_operations"."completed_at" is not null and "billing_operations"."lease_token" is null) or ("billing_operations"."state" <> 'succeeded' and "billing_operations"."result" is null and "billing_operations"."completed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "billing_object_bindings" ADD CONSTRAINT "billing_object_bindings_customer_binding_id_billing_object_bindings_id_fk" FOREIGN KEY ("customer_binding_id") REFERENCES "public"."billing_object_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_object_bindings" ADD CONSTRAINT "billing_object_bindings_price_binding_id_billing_object_bindings_id_fk" FOREIGN KEY ("price_binding_id") REFERENCES "public"."billing_object_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_object_bindings" ADD CONSTRAINT "billing_bindings_merchant_identity_fk" FOREIGN KEY ("merchant_id","oxy_app_id","environment") REFERENCES "public"."merchants"("id","oxy_app_id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "billing_operations" ADD CONSTRAINT "billing_operations_customer_binding_id_billing_object_bindings_id_fk" FOREIGN KEY ("customer_binding_id") REFERENCES "public"."billing_object_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_operations" ADD CONSTRAINT "billing_operations_price_binding_id_billing_object_bindings_id_fk" FOREIGN KEY ("price_binding_id") REFERENCES "public"."billing_object_bindings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_operations" ADD CONSTRAINT "billing_operations_merchant_identity_fk" FOREIGN KEY ("merchant_id","oxy_app_id","environment") REFERENCES "public"."merchants"("id","oxy_app_id","environment") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_bindings_customer_store_key" ON "billing_object_bindings" USING btree ("provider","platform_account_id","livemode","merchant_id","external_subject_ref") WHERE "billing_object_bindings"."kind" = 'customer';--> statement-breakpoint
CREATE UNIQUE INDEX "billing_operations_customer_claim_key" ON "billing_operations" USING btree ("provider","platform_account_id","livemode","merchant_id","subject_claim_ref") WHERE "billing_operations"."operation" = 'ensure_customer' and "billing_operations"."state" <> 'succeeded';--> statement-breakpoint
CREATE UNIQUE INDEX "billing_operations_checkout_ref_key" ON "billing_operations" USING btree ("provider","platform_account_id","livemode","provider_object_ref") WHERE "billing_operations"."operation" = 'checkout' and "billing_operations"."provider_object_ref" is not null;
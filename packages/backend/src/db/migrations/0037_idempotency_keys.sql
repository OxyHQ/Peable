-- oxy:deploy-phase=pre
CREATE TABLE "idempotency_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_merchant_id_key_key" UNIQUE("merchant_id","key"),
	CONSTRAINT "idempotency_keys_status_check" CHECK (status in ('in_progress', 'completed')),
	CONSTRAINT "idempotency_keys_key_check" CHECK ("idempotency_keys"."key" ~ '^[ -~]{1,255}$'),
	CONSTRAINT "idempotency_keys_request_hash_check" CHECK ("idempotency_keys"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_keys_method_check" CHECK ("idempotency_keys"."method" in ('POST')),
	CONSTRAINT "idempotency_keys_response_status_check" CHECK ("idempotency_keys"."response_status" is null or "idempotency_keys"."response_status" between 200 and 499),
	CONSTRAINT "idempotency_keys_completed_has_response_check" CHECK (("idempotency_keys"."status" = 'completed') = ("idempotency_keys"."response_status" is not null and "idempotency_keys"."response_body" is not null)),
	CONSTRAINT "idempotency_keys_in_progress_has_lease_check" CHECK (("idempotency_keys"."status" = 'in_progress') = ("idempotency_keys"."lease_expires_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");
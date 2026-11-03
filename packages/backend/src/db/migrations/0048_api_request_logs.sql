-- oxy:deploy-phase=pre
CREATE TABLE "api_request_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "api_request_logs_request_id_check" CHECK ("api_request_logs"."request_id" ~ '^req_[0-9a-f]+$'),
	CONSTRAINT "api_request_logs_method_check" CHECK (method in ('GET', 'POST', 'DELETE', 'PATCH', 'PUT')),
	CONSTRAINT "api_request_logs_path_check" CHECK ("api_request_logs"."path" like '/v1/%' and length("api_request_logs"."path") <= 2048 and position('?' in "api_request_logs"."path") = 0),
	CONSTRAINT "api_request_logs_status_check" CHECK ("api_request_logs"."status" between 100 and 599),
	CONSTRAINT "api_request_logs_duration_ms_check" CHECK ("api_request_logs"."duration_ms" >= 0),
	CONSTRAINT "api_request_logs_idempotency_key_check" CHECK ("api_request_logs"."idempotency_key" is null or "api_request_logs"."idempotency_key" ~ '^[ -~]{1,255}$')
);
--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_request_logs_request_id_key" ON "api_request_logs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "api_request_logs_merchant_id_id_idx" ON "api_request_logs" USING btree ("merchant_id","id");--> statement-breakpoint
CREATE INDEX "api_request_logs_created_at_idx" ON "api_request_logs" USING btree ("created_at");
-- oxy:deploy-phase=pre
CREATE TABLE "faircoin_renewal_authorizations" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"oxy_app_id" text NOT NULL,
	"environment" text NOT NULL,
	"namespace_digest" text NOT NULL,
	"authorization_ref" text NOT NULL,
	"consent" jsonb NOT NULL,
	"revocation" jsonb,
	"instructions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "faircoin_renewal_namespace_authorization_key" UNIQUE("namespace_digest","authorization_ref"),
	CONSTRAINT "faircoin_renewal_namespace_check" CHECK ("faircoin_renewal_authorizations"."namespace_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "faircoin_renewal_consent_mode_check" CHECK (("faircoin_renewal_authorizations"."environment" = 'production') = ("faircoin_renewal_authorizations"."consent"->>'mode' = 'live')),
	CONSTRAINT "faircoin_renewal_consent_environment_check" CHECK ("faircoin_renewal_authorizations"."environment" = "faircoin_renewal_authorizations"."consent"->>'environment'),
	CONSTRAINT "faircoin_renewal_instruction_array_check" CHECK (jsonb_typeof("faircoin_renewal_authorizations"."instructions") = 'array')
);
--> statement-breakpoint
ALTER TABLE "faircoin_renewal_authorizations" ADD CONSTRAINT "faircoin_renewal_merchant_identity_fk" FOREIGN KEY ("merchant_id","oxy_app_id","environment") REFERENCES "public"."merchants"("id","oxy_app_id","environment") ON DELETE restrict ON UPDATE restrict;
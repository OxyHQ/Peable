-- oxy:deploy-phase=pre
ALTER TABLE "faircoin_renewal_authorizations" ADD COLUMN "executions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "faircoin_renewal_authorizations" ADD CONSTRAINT "faircoin_renewal_execution_array_check" CHECK (jsonb_typeof("faircoin_renewal_authorizations"."executions") = 'array');
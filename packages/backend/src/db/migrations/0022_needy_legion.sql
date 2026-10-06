-- oxy:deploy-phase=pre
ALTER TABLE "provider_events" ADD COLUMN "retry_after" timestamp with time zone;
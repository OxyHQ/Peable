-- oxy:deploy-phase=pre
-- Adopting a provider-billed subscription (ADR 0018 §7), part 1 of 2: two
-- additive columns (a constant default is catalog-only, no rewrite) and the
-- CHECK tying them, re-added NOT VALID by hand so it takes no scan under
-- ACCESS EXCLUSIVE; 0078 validates it.
ALTER TABLE "subscriptions" ADD COLUMN "provider_billed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "provider_handoff_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_provider_handoff_check" CHECK (not provider_handoff_pending or provider_billed_until is not null) NOT VALID;
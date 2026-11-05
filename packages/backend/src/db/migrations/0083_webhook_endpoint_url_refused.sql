-- oxy:deploy-phase=pre
-- A webhook endpoint can be disabled `url_refused`: the outbox judges every
-- stored URL by `webhookUrlProblem` before a delivery and disables one that
-- breaks the registration rules (the 0040 backfill copied
-- `merchants.webhook_url` with only a scheme check). Widened before the new
-- image writes it, NOT VALID so it does not scan under ACCESS EXCLUSIVE; 0084
-- validates it.
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_disabled_reason_check";--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_disabled_reason_check" CHECK (disabled_reason is null or disabled_reason in ('disabled_by_merchant', 'delivery_failures', 'url_refused')) NOT VALID;

-- oxy:deploy-phase=pre
-- ADR 0015 §1 — the merchant's own account in `connected_accounts`, alone (hot
-- table). Hand edits: the three CHECKs are `NOT VALID` (validated post). Every
-- added column has a constant default or none: catalog-only.
ALTER TABLE "connected_accounts" ALTER COLUMN "external_ref" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "role" text DEFAULT 'seller' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "currently_due" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "eventually_due" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "past_due" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "pending_verification" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "business_profile" jsonb;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "settings" jsonb;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "balance_synced_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_role_check" CHECK (role in ('seller', 'merchant')) NOT VALID;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_role_external_ref_agrees_check" CHECK (("connected_accounts"."role" = 'merchant') = ("connected_accounts"."external_ref" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_merchant_role_is_card_check" CHECK ("connected_accounts"."role" <> 'merchant' or ("connected_accounts"."provider" is not null and "connected_accounts"."network" is null)) NOT VALID;

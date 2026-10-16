-- oxy:deploy-phase=pre
-- FairCoin connected accounts (ADR 0012): a marketplace's sellers are paid in
-- FairCoin straight to their own watch-only keys.
--
-- `pre`, and safe under the image that predates it:
--
--  * `connected_accounts`' card half (`provider`, `provider_account_id`,
--    `country`) only DROPS NOT NULL. The old image writes all three on every
--    row, so the agreement CHECK and `has_a_rail` are satisfied by everything it
--    can produce.
--  * The FairCoin columns are nullable or defaulted; the old image never writes
--    them.
--  * `merchant_network` is a STORED GENERATED column, computed by the server
--    from columns the old image already writes, so its inserts are unchanged.
--    Adding it REWRITES `payment_intents` and `checkout_sessions` under an
--    ACCESS EXCLUSIVE lock — proportional to their size, which is small.
--  * The network firewall is dropped and re-added over `merchant_network` in
--    this same transaction, so there is no instant without it; for every row
--    the old image can write (`connected_account_id` NULL) the new reference
--    checks exactly what the old one did.
--  * `connected_account_id` is NULL on every existing row, so the new
--    references and CHECKs are vacuous for all of them.
CREATE TABLE "connected_account_links" (
	"id" text PRIMARY KEY NOT NULL,
	"connected_account_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"return_url" text NOT NULL,
	"refresh_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "connected_account_links_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "connected_account_links_token_hash_check" CHECK (token_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "checkout_sessions" DROP CONSTRAINT "checkout_sessions_merchant_identity_fkey";
--> statement-breakpoint
ALTER TABLE "payment_intents" DROP CONSTRAINT "payment_intents_merchant_id_network_fkey";
--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "provider" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "provider_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "connected_accounts" ALTER COLUMN "country" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "connected_account_id" text;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD COLUMN "merchant_network" text GENERATED ALWAYS AS (case when connected_account_id is null then network end) STORED;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "network" text;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "faircoin_oxy_user_id" text;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "xpub" text;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "faircoin_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD COLUMN "next_derivation_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "connected_account_id" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD COLUMN "merchant_network" text GENERATED ALWAYS AS (case when connected_account_id is null then network end) STORED;--> statement-breakpoint
-- REORDERED BY HAND, and this is the ONE edit this file carries.
--
-- drizzle-kit emitted these two `ADD CONSTRAINT ... UNIQUE` statements AFTER the
-- foreign keys from `payment_intents` and `checkout_sessions` that reference
-- them, which fails with `42830 there is no unique constraint matching given
-- keys for referenced table "connected_accounts"` — the second form of the
-- ordering hazard `CONVENTIONS.md` records (a unique target added to an
-- EXISTING table has no CREATE TABLE to ride inside). `0001_certain_skin.sql`
-- is the worked example. Applied against a real PostgreSQL 17 server in this
-- order before committing.
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_id_merchant_id_network_key" UNIQUE("id","merchant_id","network");
--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_id_merchant_id_key" UNIQUE("id","merchant_id");
--> statement-breakpoint
ALTER TABLE "connected_account_links" ADD CONSTRAINT "connected_account_links_connected_account_id_fkey" FOREIGN KEY ("connected_account_id") REFERENCES "public"."connected_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connected_account_links_connected_account_id_idx" ON "connected_account_links" USING btree ("connected_account_id");--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_connected_account_network_fkey" FOREIGN KEY ("connected_account_id","merchant_id","network") REFERENCES "public"."connected_accounts"("id","merchant_id","network") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_connected_account_merchant_fkey" FOREIGN KEY ("connected_account_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_merchant_identity_fkey" FOREIGN KEY ("merchant_id","oxy_app_id","environment","merchant_network") REFERENCES "public"."merchants"("id","oxy_app_id","environment","network") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_connected_account_network_fkey" FOREIGN KEY ("connected_account_id","merchant_id","network") REFERENCES "public"."connected_accounts"("id","merchant_id","network") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_connected_account_merchant_fkey" FOREIGN KEY ("connected_account_id","merchant_id") REFERENCES "public"."connected_accounts"("id","merchant_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_merchant_id_network_fkey" FOREIGN KEY ("merchant_id","merchant_network") REFERENCES "public"."merchants"("id","network") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connected_accounts_xpub_key" ON "connected_accounts" USING btree ("xpub") WHERE "connected_accounts"."xpub" is not null;--> statement-breakpoint
CREATE INDEX "payment_intents_connected_account_id_idx" ON "payment_intents" USING btree ("connected_account_id");--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_connected_account_is_faircoin_check" CHECK ("checkout_sessions"."connected_account_id" is null or "checkout_sessions"."rail" = 'faircoin');--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_card_fields_agree_check" CHECK (("connected_accounts"."provider" is null) = ("connected_accounts"."provider_account_id" is null)
          and ("connected_accounts"."provider" is null) = ("connected_accounts"."country" is null));--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_network_check" CHECK (network is null or network in ('mainnet', 'testnet'));--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_faircoin_fields_agree_check" CHECK (("connected_accounts"."network" is null) = ("connected_accounts"."faircoin_oxy_user_id" is null)
          and ("connected_accounts"."xpub" is null) = ("connected_accounts"."faircoin_registered_at" is null)
          and ("connected_accounts"."xpub" is null or "connected_accounts"."network" is not null));--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_has_a_rail_check" CHECK ("connected_accounts"."provider" is not null or "connected_accounts"."network" is not null);--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_faircoin_oxy_user_id_check" CHECK ("connected_accounts"."faircoin_oxy_user_id" is null or length("connected_accounts"."faircoin_oxy_user_id") > 0);--> statement-breakpoint
ALTER TABLE "connected_accounts" ADD CONSTRAINT "connected_accounts_next_derivation_index_check" CHECK ("connected_accounts"."next_derivation_index" >= 0);--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_connected_account_is_faircoin_check" CHECK ("payment_intents"."connected_account_id" is null or "payment_intents"."rail" = 'faircoin');
-- oxy:deploy-phase=pre
-- A new table nothing reads yet: creating it before the rollout means the new
-- code finds it already there, and the old code neither knows nor cares.
CREATE TABLE "wallet_xpubs" (
	"id" text PRIMARY KEY NOT NULL,
	"oxy_user_id" text NOT NULL,
	"network" text NOT NULL,
	"xpub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT date_trunc('milliseconds', now()) NOT NULL,
	CONSTRAINT "wallet_xpubs_network_check" CHECK (network in ('mainnet', 'testnet'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_xpubs_oxy_user_id_network_key" ON "wallet_xpubs" USING btree ("oxy_user_id","network");
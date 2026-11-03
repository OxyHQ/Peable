-- oxy:deploy-phase=pre
-- `provider_events.received_seq`: the order this gateway received each event in,
-- the drain's tiebreak within a millisecond (a uuid v7 `id` is random there).
-- Hot-table DDL, alone: 0070 backfills the existing rows, 0071 adds the NOT NULL
-- CHECK `NOT VALID`, 0072 (post) validates it and sets NOT NULL.
-- HAND EDIT: drizzle-kit wrote `ADD COLUMN … DEFAULT nextval(…)` as ONE statement.
-- A volatile default on ADD COLUMN rewrites the whole table under ACCESS EXCLUSIVE
-- (every existing row is given a value), so it is split: the bare ADD COLUMN and the
-- SET DEFAULT are both catalog-only, and only rows inserted from here on take a value
-- from the sequence. The OWNED BY ties the sequence's lifetime to the column.
CREATE SEQUENCE "public"."provider_events_received_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "provider_events" ADD COLUMN "received_seq" bigint;--> statement-breakpoint
ALTER TABLE "provider_events" ALTER COLUMN "received_seq" SET DEFAULT nextval('provider_events_received_seq');--> statement-breakpoint
ALTER SEQUENCE "public"."provider_events_received_seq" OWNED BY "provider_events"."received_seq";

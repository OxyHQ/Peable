-- oxy:deploy-phase=pre
-- What a social payment was for, as the paying app named it: which app, and
-- that app's own opaque id for the thing (a Mention post, say).
--
-- `pre`, and there is no `post` half to follow. Both columns are nullable with
-- no default, so the image still serving keeps working through them — it simply
-- never writes them — and the new image can rely on them from its first
-- request. The three CHECKs are vacuous for exactly the rows the outgoing image
-- produces: every one of them is `<col> IS NULL OR …`, and an attribution
-- written without a source carries NULL in both columns.
--
-- NULLABLE and never backfilled, deliberately, and not a rollout artifact: most
-- social payments are one person paying another for nothing in particular, and
-- a default would invent a context the payer never stated. NULL means "no app
-- said what this was for", which is a fact; 'unknown' would be a claim, and it
-- would be one the recipient reads as if it came from the payer. Peable has no
-- users yet, so the backfill question does not even arise — but the columns
-- would still be nullable if it did.
--
-- `source_ref` is OPAQUE. Nothing parses, resolves, joins or indexes it; the
-- gateway stores a string and hands the same string back to the two parties.
-- That is what keeps "tip a post" from widening what a payment gateway knows
-- about a user: it learns that an id exists, not what it names. The length
-- CHECK is the whole defence for a column nothing reads — without it, nothing
-- downstream would ever notice the value growing into a payload.
ALTER TABLE "social_send_attributions" ADD COLUMN "source_app" text;--> statement-breakpoint
ALTER TABLE "social_send_attributions" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "social_send_attributions" ADD CONSTRAINT "social_send_attributions_source_ref_needs_app_check" CHECK (source_ref is null or source_app is not null);--> statement-breakpoint
ALTER TABLE "social_send_attributions" ADD CONSTRAINT "social_send_attributions_source_app_length_check" CHECK (source_app is null or char_length(source_app) between 1 and 32);--> statement-breakpoint
ALTER TABLE "social_send_attributions" ADD CONSTRAINT "social_send_attributions_source_ref_length_check" CHECK (source_ref is null or char_length(source_ref) between 1 and 128);
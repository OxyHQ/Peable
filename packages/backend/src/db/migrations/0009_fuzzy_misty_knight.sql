-- oxy:deploy-phase=post
-- Every social-receive cursor names the identity key its addresses came from.
--
-- `post`, and the pair with `0008` is the whole point: `0008` added the column
-- nullable BEFORE the rollout, so the image still serving kept working without
-- knowing about it; this runs AFTER, when the only image writing cursors is one
-- that fills the column on every reservation. Doing both at once would break
-- whichever image was running in between.
--
-- The DELETE is what makes the constraint possible, and it only ever removes
-- rows written before the column existed (or by the outgoing image during the
-- rollout). A cursor is a counter — the next derivation index for a user — not
-- money, not an address and not a payment: reservations are recorded separately
-- in `social_send_attributions`, which is untouched. Peable has no users yet, so
-- what this clears is test counters whose key is not recoverable from anything
-- stored. Restarting them at the first fresh index is correct for an account
-- nobody has paid.
DELETE FROM "social_receive_cursors" WHERE "identity_public_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "social_receive_cursors" ALTER COLUMN "identity_public_key" SET NOT NULL;

-- oxy:deploy-phase=post
-- Validates what 0096 added NOT VALID. VALIDATE takes SHARE UPDATE EXCLUSIVE on
-- the line items and ROW SHARE on connected_accounts, so reads and writes continue.
ALTER TABLE "checkout_session_line_items" VALIDATE CONSTRAINT "checkout_session_line_items_connected_account_fkey";

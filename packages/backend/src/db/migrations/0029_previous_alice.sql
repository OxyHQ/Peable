-- oxy:deploy-phase=pre
CREATE UNIQUE INDEX "faircoin_billing_single_use_tax_quote" ON "faircoin_billing_invoices" USING btree (("tax_snapshot"->'taxQuote'->'quote'->>'id'));
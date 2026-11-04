-- oxy:deploy-phase=post
-- oxy:lock-review=DML only: rewrites jsonb values in place, no DDL on any table; drops the two functions 0075 created.
--
-- The second half of 0075: the previous image kept serving while the new one
-- rolled out, and anything it stored in that window — a calculation, a
-- reversal, a schema 2 quote snapshot — still has number amounts. The same
-- rewrite runs once more now that the new image serves alone (it changes only
-- what is still a number), and the functions go.
SELECT peable_tax_amounts_to_strings();
--> statement-breakpoint
DROP FUNCTION peable_tax_amounts_to_strings();
--> statement-breakpoint
DROP FUNCTION peable_tax_amount_strings(jsonb);

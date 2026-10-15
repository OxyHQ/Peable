-- oxy:deploy-phase=pre
ALTER TABLE "payment_intents" ADD COLUMN "payment_link_id" text;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "contribution" jsonb;--> statement-breakpoint
ALTER TABLE "payment_links" ADD COLUMN "contribution_key" text;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_link_id_payment_links_id_fk" FOREIGN KEY ("payment_link_id") REFERENCES "public"."payment_links"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_intents_payment_link_id_idx" ON "payment_intents" USING btree ("payment_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_contribution_key" ON "payment_links" USING btree ("merchant_id","contribution_key");--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_contribution_shape" CHECK ( "payment_links"."contribution" is null or (
      jsonb_typeof("payment_links"."contribution") = 'object' and "payment_links"."rail" = 'faircoin'
      and coalesce(length("payment_links"."contribution"->>'organizationId') between 1 and 200, false)
      and coalesce(length("payment_links"."contribution"->>'purpose') between 1 and 500, false)
      and coalesce((("payment_links"."contribution"->>'amountMode' = 'fixed' and "payment_links"."amount" <> '0')
       or ("payment_links"."contribution"->>'amountMode' = 'free' and "payment_links"."amount" = '0')), false)
    ));--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_contribution_agrees" CHECK (("payment_links"."contribution" is null) = ("payment_links"."contribution_key" is null));
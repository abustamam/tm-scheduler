CREATE TABLE "officer_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"position" "officer_position" NOT NULL,
	"term_start" timestamp,
	"term_end" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "officer_terms" ADD CONSTRAINT "officer_terms_membership_id_members_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "officer_terms_membership_idx" ON "officer_terms" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "officer_terms_open_idx" ON "officer_terms" USING btree ("membership_id","term_end");--> statement-breakpoint
-- Data migration (#100): each existing non-null members.officer_position becomes
-- one OPEN-ended officer term (term_end NULL = current office). term_start is now()
-- (legacy start unknown). Runs before the column drop so no office is lost.
INSERT INTO "officer_terms" ("membership_id", "position", "term_start", "term_end")
SELECT "id", "officer_position", now(), NULL FROM "members" WHERE "officer_position" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "members" DROP COLUMN "officer_position";
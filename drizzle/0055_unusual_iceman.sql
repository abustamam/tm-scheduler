CREATE TABLE "club_logos" (
	"club_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"mime" text NOT NULL,
	"updated_at" timestamp NOT NULL,
	"attested_by" text NOT NULL,
	"attested_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "club_logos" ADD CONSTRAINT "club_logos_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_logos" ADD CONSTRAINT "club_logos_attested_by_user_id_fk" FOREIGN KEY ("attested_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
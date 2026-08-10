CREATE TABLE "meeting_ballot_guests" (
	"meeting_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_ballot_guests_meeting_id_guest_id_pk" PRIMARY KEY("meeting_id","guest_id")
);
--> statement-breakpoint
ALTER TABLE "meeting_ballot_guests" ADD CONSTRAINT "meeting_ballot_guests_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_ballot_guests" ADD CONSTRAINT "meeting_ballot_guests_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_ballot_guests_meeting_idx" ON "meeting_ballot_guests" USING btree ("meeting_id");
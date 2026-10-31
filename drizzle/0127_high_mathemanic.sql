CREATE TABLE "meeting_guest_rsvps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"meeting_id" uuid NOT NULL,
	"guest_id" uuid NOT NULL,
	"client_key" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_guest_rsvps_meeting_guest_unique" UNIQUE("meeting_id","guest_id"),
	CONSTRAINT "meeting_guest_rsvps_meeting_client_key_unique" UNIQUE("meeting_id","client_key")
);
--> statement-breakpoint
ALTER TABLE "meeting_guest_rsvps" ADD CONSTRAINT "meeting_guest_rsvps_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_guest_rsvps" ADD CONSTRAINT "meeting_guest_rsvps_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_guest_rsvps" ADD CONSTRAINT "meeting_guest_rsvps_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;
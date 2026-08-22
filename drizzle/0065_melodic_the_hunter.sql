DROP INDEX "meeting_templates_club_key_unique";--> statement-breakpoint
ALTER TABLE "meeting_templates" ADD COLUMN "meeting_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_templates" ADD CONSTRAINT "meeting_templates_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_templates_meeting_unique" ON "meeting_templates" USING btree ("meeting_id") WHERE "meeting_templates"."meeting_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_templates_club_key_unique" ON "meeting_templates" USING btree ("club_id","key") WHERE "meeting_templates"."club_id" is not null and "meeting_templates"."meeting_id" is null;
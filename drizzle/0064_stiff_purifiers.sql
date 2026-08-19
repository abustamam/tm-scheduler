CREATE TYPE "public"."template_beat_kind" AS ENUM('section', 'role', 'event');--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'meeting_template_set' BEFORE 'club_logo_set';--> statement-breakpoint
CREATE TABLE "meeting_template_beats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"kind" "template_beat_kind" NOT NULL,
	"label" text NOT NULL,
	"detail" text,
	"minutes" integer DEFAULT 0 NOT NULL,
	"role_key" text,
	"repeats_role_key" text,
	"flex" boolean DEFAULT false NOT NULL,
	"mark_green" real,
	"mark_yellow" real,
	"mark_red" real
);
--> statement-breakpoint
CREATE TABLE "meeting_template_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"category" "role_category" NOT NULL,
	"default_count" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_speaker_role" boolean DEFAULT false NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "meeting_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_length_minutes" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "role_definitions_club_key_unique";--> statement-breakpoint
ALTER TABLE "meetings" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "role_definitions" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_template_beats" ADD CONSTRAINT "meeting_template_beats_template_id_meeting_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."meeting_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_template_roles" ADD CONSTRAINT "meeting_template_roles_template_id_meeting_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."meeting_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_templates" ADD CONSTRAINT "meeting_templates_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_template_beats_order_unique" ON "meeting_template_beats" USING btree ("template_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_template_roles_key_unique" ON "meeting_template_roles" USING btree ("template_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_templates_global_key_unique" ON "meeting_templates" USING btree ("key") WHERE "meeting_templates"."club_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_templates_club_key_unique" ON "meeting_templates" USING btree ("club_id","key") WHERE "meeting_templates"."club_id" is not null;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_template_id_meeting_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."meeting_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_definitions" ADD CONSTRAINT "role_definitions_template_id_meeting_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."meeting_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "role_definitions_club_template_idx" ON "role_definitions" USING btree ("club_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_definitions_club_template_key_unique" ON "role_definitions" USING btree ("club_id","template_id","key") WHERE "role_definitions"."key" is not null and "role_definitions"."template_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "role_definitions_club_key_unique" ON "role_definitions" USING btree ("club_id","key") WHERE "role_definitions"."key" is not null and "role_definitions"."template_id" is null;
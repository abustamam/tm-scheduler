CREATE TYPE "public"."attendance_mode" AS ENUM('in_person', 'online');--> statement-breakpoint
CREATE TYPE "public"."guest_kind" AS ENUM('visitor', 'visiting_toastmaster', 'guest_speaker');--> statement-breakpoint
CREATE TYPE "public"."import_source" AS ENUM('easy_speak');--> statement-breakpoint
ALTER TYPE "public"."activity_action" ADD VALUE 'history_imported';--> statement-breakpoint
CREATE TABLE "club_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"bundle" jsonb NOT NULL,
	"bundle_sha256" text NOT NULL,
	"uploaded_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_refs" (
	"club_id" uuid NOT NULL,
	"source" "import_source" NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "import_refs_club_id_source_kind_source_id_pk" PRIMARY KEY("club_id","source","kind","source_id")
);
--> statement-breakpoint
ALTER TABLE "speeches" ALTER COLUMN "person_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "kind" "guest_kind" DEFAULT 'visitor' NOT NULL;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "home_club" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "introduced_by_member_id" uuid;--> statement-breakpoint
ALTER TABLE "meeting_attendance" ADD COLUMN "mode" "attendance_mode";--> statement-breakpoint
ALTER TABLE "speeches" ADD COLUMN "guest_id" uuid;--> statement-breakpoint
ALTER TABLE "club_imports" ADD CONSTRAINT "club_imports_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_refs" ADD CONSTRAINT "import_refs_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_imports_club_sha_unique" ON "club_imports" USING btree ("club_id","bundle_sha256");--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_introduced_by_member_id_members_id_fk" FOREIGN KEY ("introduced_by_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "speeches" ADD CONSTRAINT "speeches_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "speeches_guest_idx" ON "speeches" USING btree ("guest_id");--> statement-breakpoint
ALTER TABLE "speeches" ADD CONSTRAINT "speeches_single_owner" CHECK (("speeches"."person_id" is null) <> ("speeches"."guest_id" is null));
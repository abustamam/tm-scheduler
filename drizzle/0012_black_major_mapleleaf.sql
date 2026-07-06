CREATE TABLE "speeches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"title" text NOT NULL,
	"introduction" text,
	"pathway_path" text,
	"project_name" text,
	"project_level" text,
	"min_minutes" integer,
	"max_minutes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_slots" ADD COLUMN "speech_id" uuid;--> statement-breakpoint
ALTER TABLE "speeches" ADD CONSTRAINT "speeches_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "speeches_person_idx" ON "speeches" USING btree ("person_id");--> statement-breakpoint
ALTER TABLE "role_slots" ADD CONSTRAINT "role_slots_speech_id_speeches_id_fk" FOREIGN KEY ("speech_id") REFERENCES "public"."speeches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "role_slots_speech_unique" ON "role_slots" USING btree ("speech_id");--> statement-breakpoint
-- Data migration (ADR-0009 / #79): backfill speeches from legacy speaker_details.
-- Kept in lockstep with SPEECH_BACKFILL_SQL in src/db/speech-backfill.ts (a guard
-- test asserts this file contains that exact string). Runs here while
-- speaker_details still exists; migration 0013 drops the table afterward.
DO $$
DECLARE
	r RECORD;
	new_speech_id uuid;
BEGIN
	FOR r IN
		SELECT
			sd.slot_id,
			sd.speech_title,
			sd.pathway_path,
			sd.project_name,
			sd.project_level,
			sd.min_minutes,
			sd.max_minutes,
			rs.assigned_member_id,
			m.person_id
		FROM speaker_details sd
		JOIN role_slots rs ON rs.id = sd.slot_id
		LEFT JOIN members m ON m.id = rs.assigned_member_id
	LOOP
		-- Pure-TBA / empty placeholder → no speech, leave speech_id NULL.
		IF (r.speech_title IS NULL OR btrim(r.speech_title) = '' OR r.speech_title = 'TBA')
			AND r.pathway_path IS NULL
			AND r.project_name IS NULL
			AND r.project_level IS NULL
			AND r.min_minutes IS NULL
			AND r.max_minutes IS NULL
		THEN
			CONTINUE;
		END IF;
		-- Content row but the slot has no assignee (no Person to own the speech)
		-- → skip and log; the content can't be attributed.
		IF r.assigned_member_id IS NULL OR r.person_id IS NULL THEN
			RAISE NOTICE 'speech backfill: skipping speaker_details for slot % (no assignee/person)', r.slot_id;
			CONTINUE;
		END IF;
		INSERT INTO speeches (
			person_id, title, pathway_path, project_name,
			project_level, min_minutes, max_minutes
		)
		VALUES (
			r.person_id,
			COALESCE(NULLIF(btrim(r.speech_title), ''), 'TBA'),
			r.pathway_path,
			r.project_name,
			r.project_level,
			r.min_minutes,
			r.max_minutes
		)
		RETURNING id INTO new_speech_id;
		UPDATE role_slots SET speech_id = new_speech_id WHERE id = r.slot_id;
	END LOOP;
END $$;
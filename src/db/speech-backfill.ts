/**
 * Data-migration SQL that backfills `speeches` from the legacy `speaker_details`
 * rows (ADR-0009 / #79). This exact string is pasted into migration
 * `drizzle/0011_cooing_rhodey.sql` (which runs it in prod at container startup)
 * AND executed by `speech-migration.integration.test.ts` against a reconstructed
 * pre-migration state, so the real backfill logic is what's tested.
 *
 * Rules:
 *  - One speech per `speaker_details` row *with content*, owned by the assigned
 *    member's Person, with the slot's `speech_id` set.
 *  - Pure-TBA / empty placeholder rows (blank/"TBA" title, no other fields) →
 *    no speech row; the slot's `speech_id` stays NULL.
 *  - Content rows whose slot has no assignee (no Person to own the speech) are
 *    skipped and logged (RAISE NOTICE) — the content can't be attributed.
 *
 * A guard test (`speech-migration.integration.test.ts`) asserts the migration
 * file contains this exact string, so the two can never silently drift.
 */
export const SPEECH_BACKFILL_SQL = `DO $$
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
END $$;`;

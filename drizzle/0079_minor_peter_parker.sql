ALTER TABLE "meeting_template_beats" ADD COLUMN "club_governed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- #683 backfill. Every meeting materialised before this column existed carries a
-- Table Topics speaking row that the render path recognised by INFERENCE (kind
-- 'role' + role_key 'table_topics_master' + all three marks present). The column
-- replaces that inference, so without this every one of those rows would be
-- read as ungoverned from the next render on: the club's window would silently
-- stop tracking club settings and freeze at whatever was snapshotted at
-- materialisation, on every surface at once, with nothing throwing.
--
-- So the backfill runs the OLD predicate once, here, over data no officer can
-- edit between the read and the write, and records its answer.
--
-- DISTINCT ON (template_id) is what holds "at most one governed row per
-- meeting" — a template is private to one meeting, so per-template is
-- per-meeting. It matters because the inference this is transcribing is exactly
-- the one that could match more than one row: a club whose officer had already
-- set timer marks on the Best Table Topics vote row has TWO rows matching, and
-- marking both would hand the refresh pass two rows to overwrite forever. The
-- tie-break is the lowest sort_order, which is the speaking segment: it sits in
-- the TABLE TOPICS band and the vote row sits after the segment closes, in every
-- run of show this app has ever materialised.
UPDATE "meeting_template_beats" SET "club_governed" = true WHERE "id" IN (
	SELECT DISTINCT ON (b."template_id") b."id"
	FROM "meeting_template_beats" b
	WHERE b."kind" = 'role'
		AND b."role_key" = 'table_topics_master'
		AND b."mark_green" IS NOT NULL
		AND b."mark_yellow" IS NOT NULL
		AND b."mark_red" IS NOT NULL
	ORDER BY b."template_id", b."sort_order"
);

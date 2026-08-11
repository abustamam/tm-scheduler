/**
 * The exact backfill applied by the `meeting_attendance_plan` migration, kept as
 * a constant so `attendance-plan-backfill.integration.test.ts` verifies the SQL
 * that actually shipped rather than a paraphrase of it. No imports: this file is
 * read by a test and pasted into a migration, nothing more.
 *
 * Precedence: `not_coming` beats `reached_out`. A member who was contacted AND
 * marked unavailable loses the "we asked them" fact, which is invisible today —
 * the old `deriveOutreach` filtered unavailable members out of both its lists.
 *
 * Both statements are `ON CONFLICT DO NOTHING`, which makes the backfill
 * idempotent (safe to re-run against a partially populated table) and keeps the
 * precedence above from depending on statement order alone.
 */
export const BACKFILL_PLAN_SQL = `
INSERT INTO meeting_attendance_plan (member_id, meeting_id, status, created_at)
SELECT a.member_id, a.meeting_id, 'not_coming', a.created_at
FROM member_availability a
ON CONFLICT (member_id, meeting_id) DO NOTHING;

INSERT INTO meeting_attendance_plan (member_id, meeting_id, status, created_at)
SELECT o.member_id, o.meeting_id, 'reached_out', o.created_at
FROM meeting_outreach o
WHERE NOT EXISTS (
  SELECT 1 FROM member_availability a
  WHERE a.member_id = o.member_id AND a.meeting_id = o.meeting_id
)
ON CONFLICT (member_id, meeting_id) DO NOTHING;
`;

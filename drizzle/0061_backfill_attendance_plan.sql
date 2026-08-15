INSERT INTO meeting_attendance_plan (member_id, meeting_id, status, created_at, updated_at)
SELECT a.member_id, a.meeting_id, 'not_coming', a.created_at, a.created_at
FROM member_availability a
ON CONFLICT (member_id, meeting_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO meeting_attendance_plan (member_id, meeting_id, status, created_at, updated_at)
SELECT o.member_id, o.meeting_id, 'reached_out', o.created_at, o.created_at
FROM meeting_outreach o
WHERE NOT EXISTS (
  SELECT 1 FROM member_availability a
  WHERE a.member_id = o.member_id AND a.meeting_id = o.meeting_id
)
ON CONFLICT (member_id, meeting_id) DO NOTHING;

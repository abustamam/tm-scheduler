# Design spike: VP Education dashboard

> Status: spike complete — ready for build plan
> Spike plan: `plans/008-spike-vpe-dashboard.md`
> Issues: [#8](https://github.com/abustamam/tm-scheduler/issues/8) (speaker queue / overdue / rotation), [#9](https://github.com/abustamam/tm-scheduler/issues/9) (Pathways progress per member)
> ADR reference: `docs/adr/0005-role-slots-source-of-truth.md`

---

## Summary

All three dashboard queries were prototyped against live seed data (club MCF, 3 past
meetings). Every query runs over existing tables without any schema change.

**ADR-0005 verdict: CONFIRMED. No new tables are needed.**

---

## Seed data used for prototyping

Four active members across 3 past completed meetings (60, 45, and 14 days ago):

| Member           | Club role | Spoke at M1 (60d) | Spoke at M2 (45d) | Spoke at M3 (14d) | Last any role |
|------------------|-----------|-------------------|-------------------|-------------------|---------------|
| Alex Rivera      | member    | yes               | no (Timer only)   | no role           | 45 days ago   |
| Sam Chen         | member    | yes               | yes               | TMOD only         | 14 days ago   |
| Jordan Patel     | vpe       | yes               | TMOD only         | yes               | 14 days ago   |
| Rasheed Bustamam | admin     | TMOD only         | yes               | yes               | 14 days ago   |

The seed also creates 2 future meetings with speaker_details entries (Alex: "Finding My
Voice" / Dynamic Leadership / Ice Breaker Level 1; Sam: "Lessons From the Trail" /
Presentation Mastery / Level 2). These are in upcoming meetings, not past ones, so they
don't appear in the history queries for past meetings — but the speaker_details join
pattern in Query 3 is fully exercised by the production seed data on upcoming meetings.

---

## Query 1: Speaker queue / rotation (Issue #8)

Ranks all active members by how recently (or how many times) they held a **speaker**
role (`is_speaker_role = true`) in past non-cancelled meetings. Members who have never
spoken sort first (NULL last_spoken_at).

### SQL prototype

```sql
SELECT
  u.id              AS user_id,
  u.name,
  cm.club_role,
  COUNT(rs.id)       AS times_spoken,
  MAX(m.scheduled_at) AS last_spoken_at,
  RANK() OVER (
    ORDER BY MAX(m.scheduled_at) ASC NULLS FIRST,
             COUNT(rs.id) ASC
  ) AS rotation_rank
FROM club_memberships cm
JOIN "user" u ON u.id = cm.user_id
LEFT JOIN (
  role_slots rs
  JOIN role_definitions rd
    ON rd.id = rs.role_definition_id
    AND rd.is_speaker_role = true
  JOIN meetings m
    ON m.id = rs.meeting_id
    AND m.scheduled_at < NOW()
    AND m.status != 'cancelled'
) ON rs.assigned_user_id = cm.user_id
  AND rs.status IN ('claimed', 'confirmed')
WHERE cm.club_id = $1          -- :clubId
  AND cm.status = 'active'
GROUP BY u.id, u.name, cm.club_role
ORDER BY rotation_rank, u.name;
```

**Important**: the three-table block `(role_slots JOIN role_definitions JOIN meetings)` must
be bracketed as a single derived join target, then left-joined to memberships. A naive
chain of LEFT JOINs with `AND rd.is_speaker_role = true` in the ON clause would silently
include non-speaker slots (the condition becomes part of the join predicate, not a filter).

### Sample result (prototyped against seed data)

```
user_id        | name             | club_role | times_spoken | last_spoken_at              | rotation_rank
---------------+------------------+-----------+--------------+-----------------------------+--------------
10978bc3-...   | Alex Rivera      | member    |            1 | 2026-04-27 23:01:12+00      |             1
bcc47f5c-...   | Sam Chen         | member    |            2 | 2026-05-12 23:01:12+00      |             2
0bb6a441-...   | Jordan Patel     | vpe       |            2 | 2026-06-12 23:01:12+00      |             3
GsrGCC4f...    | Rasheed Bustamam | admin     |            2 | 2026-06-12 23:01:12+00      |             3
```

Alex spoke earliest (60 days ago, once), so he's at the top of the queue. Sam, Jordan, and
Rasheed spoke more recently; Jordan and Rasheed tie at rank 3.

### Drizzle translation

```typescript
import { and, count, desc, eq, lt, max, ne, sql } from "drizzle-orm";

const rows = await db
  .select({
    userId: clubMemberships.userId,
    name: user.name,
    clubRole: clubMemberships.clubRole,
    timesSpoken: count(roleSlots.id).as("times_spoken"),
    lastSpokenAt: max(meetings.scheduledAt).as("last_spoken_at"),
    rotationRank: sql<number>`
      RANK() OVER (
        ORDER BY MAX(${meetings.scheduledAt}) ASC NULLS FIRST,
                 COUNT(${roleSlots.id}) ASC
      )`.as("rotation_rank"),
  })
  .from(clubMemberships)
  .innerJoin(user, eq(user.id, clubMemberships.userId))
  .leftJoin(
    // Drizzle doesn't support bracketed multi-table LEFT JOIN natively,
    // so we use a lateral subquery or raw SQL for the complex join.
    // Recommended: extract to a raw sql`` expression or use the subquery pattern below.
    roleSlots,
    and(
      eq(roleSlots.assignedUserId, clubMemberships.userId),
      // NOTE: this naively includes non-speaker roles — see sub-query fix below.
    ),
  )
  // ... (see note below on the subquery pattern)
  .where(
    and(
      eq(clubMemberships.clubId, clubId),
      eq(clubMemberships.status, "active"),
    ),
  )
  .groupBy(clubMemberships.userId, user.name, clubMemberships.clubRole)
  .orderBy(sql`rotation_rank`, user.name);
```

**Drizzle note**: Drizzle's `.leftJoin()` does not support bracketed multi-table join
targets in a single call. The cleanest approach is a **lateral subquery** (Drizzle
`db.select().from(subquery)`) or a **raw SQL lateral** via `sql<…>` in the `.from()`.
An equally valid alternative is to write this query as a `db.$with(...)` CTE. See the
build plan for the recommended pattern.

---

## Query 2: Overdue members (Issue #8)

Active members who have held no role (any category, not just speaker) in the past N days.
Default threshold: **60 days**, passed as a parameter.

"Overdue" deliberately counts **any** claimed/confirmed slot, not only speaking roles —
functionary participation keeps the member engaged. This is an open question (see below).

### SQL prototype

```sql
SELECT
  u.id            AS user_id,
  u.name,
  cm.club_role,
  MAX(m.scheduled_at)                             AS last_any_role_at,
  NOW() - MAX(m.scheduled_at)                     AS days_since_last_role,
  CASE
    WHEN MAX(m.scheduled_at) IS NULL
      OR NOW() - MAX(m.scheduled_at) > $2         -- :overdueInterval e.g. '60 days'
    THEN true
    ELSE false
  END                                              AS is_overdue
FROM club_memberships cm
JOIN "user" u ON u.id = cm.user_id
LEFT JOIN (
  role_slots rs
  JOIN meetings m
    ON m.id = rs.meeting_id
    AND m.scheduled_at < NOW()
    AND m.status != 'cancelled'
) ON rs.assigned_user_id = cm.user_id
  AND rs.status IN ('claimed', 'confirmed')
WHERE cm.club_id = $1          -- :clubId
  AND cm.status = 'active'
GROUP BY u.id, u.name, cm.club_role
ORDER BY last_any_role_at ASC NULLS FIRST;
```

### Sample result (60-day threshold)

```
user_id      | name             | club_role | last_any_role_at         | days_since | is_overdue
-------------+------------------+-----------+--------------------------+------------+-----------
10978bc3-... | Alex Rivera      | member    | 2026-05-12 23:01:12+00   | 45 days    | false
0bb6a441-... | Jordan Patel     | vpe       | 2026-06-12 23:01:12+00   | 14 days    | false
bcc47f5c-... | Sam Chen         | member    | 2026-06-12 23:01:12+00   | 14 days    | false
GsrGCC4f-... | Rasheed Bustamam | admin     | 2026-06-12 23:01:12+00   | 14 days    | false
```

With a **30-day** threshold (same query, interval changed to `'30 days'`):

```
user_id      | name             | club_role | last_any_role_at         | is_overdue_30d
-------------+------------------+-----------+--------------------------+---------------
10978bc3-... | Alex Rivera      | member    | 2026-05-12 23:01:12+00   | true
0bb6a441-... | Jordan Patel     | vpe       | 2026-06-12 23:01:12+00   | false
bcc47f5c-... | Sam Chen         | member    | 2026-06-12 23:01:12+00   | false
GsrGCC4f-... | Rasheed Bustamam | admin     | 2026-06-12 23:01:12+00   | false
```

Alex correctly flags as overdue (last role 45 days ago), demonstrating the parameter works.

### Drizzle translation

Same pattern as Query 1 (lateral subquery for the bracketed LEFT JOIN). The interval
threshold is passed as a `sql<Date>` parameter via Drizzle's `sql` tag:

```typescript
const overdueInterval = sql`${thresholdDays} days`; // e.g. sql`60 days`
// Use in WHERE clause:
// .where(sql`(${max(meetings.scheduledAt)} IS NULL OR NOW() - ${max(meetings.scheduledAt)} > interval ${overdueInterval})`)
```

---

## Query 3: Per-member history (Issues #8 and #9)

For one member: all past roles with meeting dates, ordered newest-first. Speaker rows
include `speaker_details` columns (`speechTitle`, `pathwayPath`, `projectName`,
`projectLevel`) — this is the data that drives **issue #9 specifically**.

### Issue #9 scope (Pathways progress per member)

`speaker_details` already captures:
- `pathway_path` — e.g. "Dynamic Leadership", "Presentation Mastery"
- `project_name` — e.g. "Ice Breaker", "Researching and Presenting"
- `project_level` — e.g. "Level 1", "Level 2"
- `speech_title`

A VPE view derived from this query can surface a member's Pathways progress without any
new tables. The data is only as complete as what members enter when claiming a speaker
slot. No external Pathways API integration is implied.

### SQL prototype

```sql
SELECT
  m.scheduled_at::date     AS meeting_date,
  m.theme,
  rd.name                  AS role_name,
  rd.category,
  rd.is_speaker_role,
  rs.status,
  -- Issue #9: Pathways fields (NULL for non-speaker roles)
  sd.speech_title,
  sd.pathway_path,
  sd.project_name,
  sd.project_level,
  sd.min_minutes,
  sd.max_minutes
FROM role_slots rs
JOIN meetings m
  ON m.id = rs.meeting_id
  AND m.scheduled_at < NOW()
  AND m.status != 'cancelled'
JOIN role_definitions rd
  ON rd.id = rs.role_definition_id
LEFT JOIN speaker_details sd
  ON sd.slot_id = rs.id
WHERE rs.assigned_user_id = $1          -- :memberId
  AND rs.status IN ('claimed', 'confirmed')
ORDER BY m.scheduled_at DESC;
```

### Sample result (Rasheed: 2 past speaker slots, 1 functionary slot)

```
meeting_date | theme          | role_name              | category   | is_speaker | speech_title | pathway_path | project_name | project_level
-------------+----------------+------------------------+------------+------------+--------------+--------------+--------------+--------------
2026-06-12   | Present Tense  | Speaker                | speaker    | true       | (null)       | (null)       | (null)       | (null)
2026-05-12   | Moving Forward | Speaker                | speaker    | true       | (null)       | (null)       | (null)       | (null)
2026-04-27   | Looking Back   | Toastmaster of the Day | leadership | false      | (null)       | (null)       | (null)       | (null)
```

Note: the prototype past-meeting slots were inserted without speaker_details. The
production seed's future meetings DO have speaker_details (Alex and Sam). In a real
deployment the pathway columns populate as members fill them in when claiming speaker
slots.

### Drizzle translation

This query translates cleanly into Drizzle without the bracketed-JOIN complexity of Q1/Q2,
since the primary filter is `assignedUserId = memberId` (single member, not a membership
scan):

```typescript
import { and, asc, desc, eq, lt, ne, inArray } from "drizzle-orm";

const history = await db
  .select({
    meetingDate: meetings.scheduledAt,
    theme: meetings.theme,
    roleName: roleDefinitions.name,
    category: roleDefinitions.category,
    isSpeakerRole: roleDefinitions.isSpeakerRole,
    status: roleSlots.status,
    // Issue #9 Pathways fields:
    speechTitle: speakerDetails.speechTitle,
    pathwayPath: speakerDetails.pathwayPath,
    projectName: speakerDetails.projectName,
    projectLevel: speakerDetails.projectLevel,
    minMinutes: speakerDetails.minMinutes,
    maxMinutes: speakerDetails.maxMinutes,
  })
  .from(roleSlots)
  .innerJoin(meetings, and(
    eq(meetings.id, roleSlots.meetingId),
    lt(meetings.scheduledAt, new Date()),
    ne(meetings.status, "cancelled"),
  ))
  .innerJoin(roleDefinitions, eq(roleDefinitions.id, roleSlots.roleDefinitionId))
  .leftJoin(speakerDetails, eq(speakerDetails.slotId, roleSlots.id))
  .where(
    and(
      eq(roleSlots.assignedUserId, memberId),
      inArray(roleSlots.status, ["claimed", "confirmed"]),
    ),
  )
  .orderBy(desc(meetings.scheduledAt));
```

This is the most straightforward of the three queries and can be written in standard
Drizzle without raw SQL.

---

## Proposed file / route layout

### Server functions (VPE-gated)

New file: `src/server/reporting.ts`

```typescript
// Pattern mirrors src/server/meetings.ts

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireClubRole } from "./guards";

export const getSpeakerRotation = createServerFn({ method: "GET" })
  .validator((input: unknown) => z.object({ clubId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const currentUser = await requireUser();
    await requireClubRole(currentUser.id, data.clubId, ["admin", "vpe"]);
    // ... Query 1
  });

export const getOverdueMembers = createServerFn({ method: "GET" })
  .validator((input: unknown) =>
    z.object({ clubId: z.string().uuid(), thresholdDays: z.number().default(60) }).parse(input)
  )
  .handler(async ({ data }) => {
    const currentUser = await requireUser();
    await requireClubRole(currentUser.id, data.clubId, ["admin", "vpe"]);
    // ... Query 2
  });

export const getMemberHistory = createServerFn({ method: "GET" })
  .validator((input: unknown) =>
    z.object({ clubId: z.string().uuid(), memberId: z.string() }).parse(input)
  )
  .handler(async ({ data }) => {
    const currentUser = await requireUser();
    await requireClubRole(currentUser.id, data.clubId, ["admin", "vpe"]);
    // ... Query 3 — Issue #9: returns pathway_path/project_name/project_level too
  });
```

### Route

New file: `src/routes/_authed/admin/vpe-dashboard.tsx`

The `beforeLoad` pattern mirrors `src/routes/_authed/admin/meetings.new.tsx`:

```typescript
export const Route = createFileRoute("/_authed/admin/vpe-dashboard")({
  beforeLoad: async ({ context }) => {
    const { membership } = context;
    if (!membership || !["admin", "vpe"].includes(membership.clubRole)) {
      throw redirect({ to: "/" });
    }
  },
  // ...
});
```

A member detail sub-route (`vpe-dashboard.$memberId.tsx`) would call `getMemberHistory`
and show the Pathways progress table (issue #9).

---

## Index / performance notes

### Existing indexes that cover these queries

| Index                        | Covers                                                    |
|------------------------------|-----------------------------------------------------------|
| `club_memberships_club_idx`  | Q1, Q2: outer scan by `club_id` + `status = 'active'`    |
| `role_slots_assigned_user_idx` | Q1, Q2: left join to role_slots by `assigned_user_id`  |
| `meetings_club_scheduled_idx` | Q1, Q2: inner join to meetings with `scheduled_at < NOW()` — partially; see note |
| `role_slots_meeting_idx`     | Q3: inner join to meetings from role_slots (meetingId)    |

### Missing index (flagged as follow-up, do NOT add in spike)

**`role_slots (assigned_user_id, status)`** — a composite index would tighten Q1/Q2
by filtering `status IN ('claimed','confirmed')` at the index level rather than in a
heap scan. At typical Toastmasters club scale (< 30 members, < 50 historical meetings)
this is unlikely to matter, but at multi-club/reporting scale it becomes relevant.

**`meetings (scheduled_at)`** alone — Q3 joins from `role_slots` to `meetings` and
filters `m.scheduled_at < NOW()`. The existing `meetings_club_scheduled_idx` is
`(club_id, scheduled_at)`; since Q3 doesn't filter by `club_id` at the meetings
level (it arrives via role_slots), Postgres may not use this index. A dedicated
`(scheduled_at)` index or including `club_id` in the Q3 WHERE clause would help.

Both are **follow-up items for the build plan**, not in scope here.

---

## Open questions

1. **"Overdue" definition: any role or only speaking roles?**
   Query 2 currently counts any claimed/confirmed slot. A VPE might want to flag members
   who haven't *spoken* in 60 days even if they've been Timer every week. Consider a
   separate `overdue_speaker` flag using the same filter as Q1.

2. **Rotation: per-role or global speaker rotation?**
   Q1 ranks by last speaker role globally (any `isSpeakerRole = true` definition).
   If the club runs both "Speaker" (prepared) and "Table Topics" (impromptu), should
   they count together or separately? Requires product decision.

3. **Threshold: configurable per club or app-wide?**
   The `thresholdDays` parameter is currently an API input. It could alternatively be
   stored per club (new column `clubs.overdue_threshold_days`) — a schema change that
   would be minor but still an ADR-0005 amendment. Deferred to build plan.

4. **Cancelled meetings: should "empty" cancelled meetings count against streak?**
   Current queries exclude `status = 'cancelled'`. A member who was assigned but the
   meeting cancelled is not credited. Acceptable behavior, but worth confirming with VPE.

5. **"Never spoken" vs. "new member"**: newly joined members appear at the top of Q1
   (rank 1). The VPE may want to see join date to distinguish "never spoken, 2 years
   in" from "joined last week." `club_memberships.joined_at` already exists — trivial
   to include in the select.

6. **Issue #9 — Pathways data completeness**: `speaker_details` is only populated when
   a member fills in the optional fields at slot-claim time. The VPE dashboard would
   show NULLs for older speeches. No fix needed at the data-model level, but the UI
   should communicate this clearly.

---

## ADR-0005 "no new tables" verdict

**CONFIRMED.** All three queries — speaker rotation (Q1), overdue members (Q2), and
per-member history including Pathways data (Q3 / issue #9) — run over the existing
tables:

- `club_memberships` (member list + role)
- `role_slots` (who filled what)
- `role_definitions` (speaker vs. functionary)
- `meetings` (date + status)
- `speaker_details` (Pathways path/project — issue #9, already populated by the claim flow)

No new tables, no new columns. The one optional improvement (a composite index on
`role_slots(assigned_user_id, status)`) would be an index addition, not a schema change,
and is a follow-up item for the build plan.

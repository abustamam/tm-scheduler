import type { MeetingWriteOptions } from "#/lib/meeting-lifecycle";

/**
 * A `plan` check that lets a CANCELLED meeting through (#1135).
 *
 * Used where a writer's refusals are ordered, and a later check owns the
 * cancelled one: the early call refuses what has always been refused first (a
 * completed meeting, ahead of the proof, role or validation checks) and hands
 * `cancelled` on, so a caller who fails the later check still hears THAT
 * sentence rather than the meeting's status. A cancelled meeting is hidden from
 * members, so which sentence an outsider hears is not cosmetic (#1057, #1085).
 * Every writer that passes it also refuses `cancelled` further down, by the
 * statement's own predicate, a plain `assertMeetingAccepts(…, "plan")` after the
 * role gate, or the plan seam; a call site says which.
 *
 * A writer that accepts `cancelled` for a DIFFERENT reason (a sync that
 * deliberately covers cancelled meetings, a speech leaving one) passes it too,
 * and says that reason where it does.
 *
 * `availability-authz.guard.test.ts` pins this exact value, because it is read
 * from here by three handlers whose guard reads only their own source.
 */
export const PLAN_ACCEPTING_CANCELLED = {
	accept: ["cancelled"],
} as const satisfies MeetingWriteOptions;

/**
 * Server-fn wrapper for the personal meeting page (#665).
 *
 * Exports only `createServerFn`s and types, per CLAUDE.md's "Server modules
 * must keep `pg` out of the client bundle": the route file below imports this
 * module, and a plain top-level db-touching export here would drag `#/db` →
 * `pg` → `Buffer` into the browser. The query lives in
 * `personal-meeting-logic.ts`, which client code never imports.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { loadPublicPersonalMeetingView } from "#/server/personal-meeting-logic";

export type {
	PersonalMeetingRole,
	PersonalMeetingView,
} from "#/server/personal-meeting-logic";

/**
 * Loose `z.string()`, NOT `z.string().uuid()`, on both ids — deliberately.
 *
 * A malformed `?as=` must be REJECTED, not throw: the page falls through to the
 * normal identity picker, and a 500 out of the loader would take the whole page
 * down instead. `loadPublicPersonalMeetingView` shape-checks both ids itself and
 * collapses a bad one into the same `null` as an unknown meeting, so validating
 * here would convert a designed not-found into an error for no gain.
 */
const personalMeetingSchema = z.object({
	/** Club UUID from the shell's resolved route context. */
	clubId: z.string(),
	/** The raw `$meetingId` URL segment — date key, date-HHmm key, or uuid. */
	meetingKey: z.string(),
	memberId: z.string(),
});

/** The personal view of a meeting for one member. PUBLIC — no session; gates
 *  itself on `clubs.archived_at` via the seam. */
export const getPublicPersonalMeetingView = createServerFn({ method: "GET" })
	.validator((i: unknown) => personalMeetingSchema.parse(i))
	.handler(async ({ data }) => loadPublicPersonalMeetingView(data));

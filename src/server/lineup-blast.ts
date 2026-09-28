import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSessionUser } from "./guards";
import {
	loadLineupBlastData,
	requireLineupBlastAccess,
	resolveLineupBlastAccess,
} from "./lineup-blast-logic";

// Lineup blast (#1024). The db-touching logic lives in `lineup-blast-logic.ts`
// so it can't drag `#/db` → `pg` into the browser bundle; this module exports
// ONLY createServerFns + types (`server-modules.guard.test.ts`).
//
// Nothing here SENDS anything. The server returns the data a draft is built
// from, the browser builds the draft (`#/lib/lineup-blast`) with its own origin,
// and a human copies it into their own app.
export type { LineupBlastData } from "#/lib/lineup-blast";

const inputSchema = z.object({
	meetingId: z.uuid(),
	/** The Toastmaster arm's self-asserted roster id (ADR-0010), or null. */
	selfMemberId: z.uuid().nullable().optional(),
});

/**
 * Whether the caller may draft this meeting's lineup: a club admin, an
 * officer, or this meeting's Toastmaster (`mayDraftLineupBlast`). The meeting
 * page shows the button on this answer. Session OPTIONAL: an anonymous
 * Toastmaster passes on the slot they hold, as they do for the agenda.
 */
export const getLineupBlastAccess = createServerFn({ method: "GET" })
	.validator((input: unknown) => inputSchema.parse(input))
	.handler(async ({ data }) => {
		const user = await getSessionUser();
		const access = await resolveLineupBlastAccess({
			meetingId: data.meetingId,
			sessionUserId: user?.id ?? null,
			selfMemberId: data.selfMemberId ?? null,
		});
		return { allowed: access.allowed };
	});

/**
 * What the Lineup blast sheet drafts from. Refuses anyone
 * `getLineupBlastAccess` would answer no for, and an archived club.
 */
export const getLineupBlast = createServerFn({ method: "GET" })
	.validator((input: unknown) => inputSchema.parse(input))
	.handler(async ({ data }) => {
		const user = await getSessionUser();
		await requireLineupBlastAccess({
			meetingId: data.meetingId,
			sessionUserId: user?.id ?? null,
			selfMemberId: data.selfMemberId ?? null,
		});
		return loadLineupBlastData(data.meetingId);
	});

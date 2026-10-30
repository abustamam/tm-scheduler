// Cover requests (#1438): the server functions. The writes live in
// `cover-logic.ts` (this module may not export db-touching functions); what stays
// here is the one thing that cannot move, the request-scoped session read.
import { createServerFn } from "@tanstack/react-start";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, roleSlots } from "#/db/schema";
import {
	askForCoverCore,
	loadCoverCandidatesCore,
	releaseOwnSlotForCoverCore,
	undoReleaseForCoverCore,
} from "./cover-logic";
import { withDeadlockRetry } from "./deadlock-retry";
import { requireMembership, requireUser } from "./guards";
import { requireSessionActor } from "./write-actor-logic";

const uuid = z.string().uuid();

/** The slot's owning club, for the session gate. The authoritative read runs
 *  under a row lock in the core. */
async function clubOfSlot(slotId: string): Promise<string> {
	const [slot] = await db
		.select({ clubId: meetings.clubId })
		.from(roleSlots)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(eq(roleSlots.id, slotId))
		.limit(1);
	if (!slot) throw new Error("Role not found.");
	return slot.clubId;
}

const releaseSchema = z.object({
	slotId: uuid,
	kind: z.enum(["finding_cover", "dropped"]),
});

/** Hand off your OWN role and record a cover request. AUTHED: a session bound to
 *  the member who holds the role; the core refuses everyone else. */
export const releaseOwnSlotForCover = createServerFn({ method: "POST" })
	.validator((input: unknown) => releaseSchema.parse(input))
	.handler(async ({ data }) => {
		// A user first: the session sweep reads `requireUser` by name.
		await requireUser();
		const { memberId } = await requireSessionActor({
			clubId: await clubOfSlot(data.slotId),
		});
		await db.transaction((tx) =>
			releaseOwnSlotForCoverCore(tx, {
				slotId: data.slotId,
				actorMemberId: memberId,
				kind: data.kind,
			}),
		);
		return { ok: true as const };
	});

const slotOnlySchema = z.object({ slotId: uuid });

/** Take a cover release back: the toast's Undo. AUTHED. Refused with "Someone
 *  already took it." unless the slot is still open and the caller released it. */
export const undoReleaseForCover = createServerFn({ method: "POST" })
	.validator((input: unknown) => slotOnlySchema.parse(input))
	.handler(async ({ data }) => {
		// A user first: the session sweep reads `requireUser` by name.
		await requireUser();
		const { memberId } = await requireSessionActor({
			clubId: await clubOfSlot(data.slotId),
		});
		// One retry on a deadlock with a member edit, as `claimSlot` does.
		await withDeadlockRetry(() =>
			db.transaction((tx) =>
				undoReleaseForCoverCore(tx, {
					slotId: data.slotId,
					actorMemberId: memberId,
				}),
			),
		);
		return { ok: true as const };
	});

/** The releaser of a role a decline freed asks for cover on it. AUTHED. */
export const askForCover = createServerFn({ method: "POST" })
	.validator((input: unknown) => slotOnlySchema.parse(input))
	.handler(async ({ data }) => {
		// A user first: the session sweep reads `requireUser` by name.
		await requireUser();
		const { memberId } = await requireSessionActor({
			clubId: await clubOfSlot(data.slotId),
		});
		await db.transaction((tx) =>
			askForCoverCore(tx, { slotId: data.slotId, actorMemberId: memberId }),
		);
		return { ok: true as const };
	});

const candidatesSchema = z.object({ meetingId: uuid, slotId: uuid });

/** Up to five members to ask, by name, never with contact. AUTHED: any active
 *  member of the club (the archive gate rides `requireMembership`). */
export const loadCoverCandidates = createServerFn({ method: "GET" })
	.validator((input: unknown) => candidatesSchema.parse(input))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireMembership(user.id, await clubOfSlot(data.slotId));
		return loadCoverCandidatesCore(data);
	});

// Mentorship server fns (#939). Thin `createServerFn` wrappers ONLY: all db
// logic lives in `mentorship-logic.ts` so the Start compiler strips it from the
// client bundle (enforced by `server-modules.guard.test.ts`).
//
//  - `getMyMentorships`: the caller's own mentors and mentees. Member-level
//    read gate, answered from the GATE's membership; a read-only impersonator
//    has none and gets null. Writes nothing.
//  - `getMemberMentorships` / `listClubMentorships`: admin view gate. Write
//    nothing.
//  - `setMyWillingToMentor`: the member's own row only. The logic resolves it
//    from the session (`ownMembershipId`); the input names no member.
//  - `createMentorship` / `endMentorship` / `setMentorshipFocus`: admin writes
//    about other people, `requireClubRole(…, ["admin"])`.
// `mentorship-authz.guard.test.ts` pins each gate before its call.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
	requireClubAdminView,
	requireClubRole,
	requireClubViewAccess,
	requireUser,
} from "./guards";
import {
	createMentorship as createMentorshipDb,
	createMentorshipSchema,
	endMentorship as endMentorshipDb,
	endMentorshipSchema,
	loadClubMentorships as loadClubMentorshipsDb,
	loadMemberMentorships as loadMemberMentorshipsDb,
	loadMyMentorships as loadMyMentorshipsDb,
	setMentorshipFocus as setMentorshipFocusDb,
	setMentorshipFocusSchema,
	setMyWillingToMentor as setMyWillingToMentorDb,
	setWillingToMentorSchema,
} from "./mentorship-logic";

export type {
	ClubMentorshipRow,
	ClubMentorships,
	MemberMentorships,
	MentorshipParty,
	MentorshipRow,
	MyMentorships,
} from "./mentorship-logic";

const clubScoped = z.object({ clubId: z.string().uuid() });
const memberScoped = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
});

/** The signed-in member's own mentors and mentees in this club, or null. */
export const getMyMentorships = createServerFn({ method: "GET" })
	.validator((i: unknown) => clubScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const access = await requireClubViewAccess(user.id, data.clubId);
		if (!access.membership) return null;
		return loadMyMentorshipsDb(access.membership.id);
	});

/** One member's pairings and the mentor picker, for an admin. */
export const getMemberMentorships = createServerFn({ method: "GET" })
	.validator((i: unknown) => memberScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return loadMemberMentorshipsDb(data);
	});

/** Every active pairing, and who has no mentor, for an admin. */
export const listClubMentorships = createServerFn({ method: "GET" })
	.validator((i: unknown) => clubScoped.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubAdminView(user.id, data.clubId);
		return loadClubMentorshipsDb(data.clubId);
	});

export const setMyWillingToMentor = createServerFn({ method: "POST" })
	.validator((i: unknown) => setWillingToMentorSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		return setMyWillingToMentorDb({ ...data, userId: user.id });
	});

export const createMentorship = createServerFn({ method: "POST" })
	.validator((i: unknown) => createMentorshipSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		return createMentorshipDb({ ...data, actorMemberId: membership.id });
	});

export const endMentorship = createServerFn({ method: "POST" })
	.validator((i: unknown) => endMentorshipSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		await endMentorshipDb({ ...data, actorMemberId: membership.id });
		return { ok: true as const };
	});

export const setMentorshipFocus = createServerFn({ method: "POST" })
	.validator((i: unknown) => setMentorshipFocusSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		const membership = await requireClubRole(user.id, data.clubId, ["admin"]);
		await setMentorshipFocusDb({ ...data, actorMemberId: membership.id });
		return { ok: true as const };
	});

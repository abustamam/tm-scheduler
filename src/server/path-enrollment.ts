/**
 * Server fns for manual path enrollment (#417). Exports ONLY `createServerFn`s
 * and types — the db logic lives in `path-enrollment-logic.ts`, because a plain
 * db-touching export in this module would drag `#/db` → `pg` → `Buffer` into the
 * client bundle and white-screen the page. Enforced by
 * `server-modules.guard.test.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./guards";
import {
	archiveEnrollment,
	type EnrollablePath,
	enrollInPath,
	listEnrollablePaths,
	listMemberEnrollments,
	type MemberEnrollment,
	resolveEnrollmentAuthz,
	selfPersonId,
} from "./path-enrollment-logic";

export type { EnrollablePath, MemberEnrollment };

/**
 * The 11 real paths, for the "declare a path" picker. Signed-in only — this is
 * a write affordance, and nothing anonymous can act on it.
 */
export const listPathwayOptions = createServerFn({ method: "GET" }).handler(
	async (): Promise<EnrollablePath[]> => {
		await requireUser();
		return listEnrollablePaths();
	},
);

const pathSchema = z.object({ pathId: z.string().uuid() });

/**
 * Self surface — no club, because `path_enrollments` keys on `person_id` and a
 * Toastmaster's path follows them across clubs. The dashboard has no memberId
 * to hand anyway, and inventing one would only add a way to get it wrong.
 *
 * An account with no linked person returns empty rather than throwing: being
 * signed in without a roster row is an ordinary state, not an error.
 */
export const getMyPathEnrollments = createServerFn({ method: "GET" }).handler(
	async (): Promise<MemberEnrollment[]> => {
		const user = await requireUser();
		const personId = await selfPersonId(user.id);
		return personId ? listMemberEnrollments(personId) : [];
	},
);

export const addMyPath = createServerFn({ method: "POST" })
	.validator((i: unknown) => pathSchema.parse(i))
	.handler(async ({ data }): Promise<MemberEnrollment[]> => {
		const user = await requireUser();
		const personId = await selfPersonId(user.id);
		if (!personId) {
			throw new Error("Your account isn't linked to a club roster yet.");
		}
		await enrollInPath(personId, data.pathId);
		return listMemberEnrollments(personId);
	});

export const removeMyPath = createServerFn({ method: "POST" })
	.validator((i: unknown) => pathSchema.parse(i))
	.handler(async ({ data }): Promise<MemberEnrollment[]> => {
		const user = await requireUser();
		const personId = await selfPersonId(user.id);
		if (!personId) {
			throw new Error("Your account isn't linked to a club roster yet.");
		}
		await archiveEnrollment(personId, data.pathId);
		return listMemberEnrollments(personId);
	});

const memberSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
});

const mutateSchema = memberSchema.extend({
	pathId: z.string().uuid(),
});

/**
 * A member's declared paths. Behind the same authz as the writes rather than
 * being a public read: it drives the management UI, and showing someone the
 * controls they can't use is worse than not showing them.
 */
export const getMemberEnrollments = createServerFn({ method: "GET" })
	.validator((i: unknown) => memberSchema.parse(i))
	.handler(async ({ data }): Promise<MemberEnrollment[]> => {
		const user = await requireUser();
		const { personId } = await resolveEnrollmentAuthz({
			userId: user.id,
			clubId: data.clubId,
			memberId: data.memberId,
		});
		return listMemberEnrollments(personId);
	});

/** Declare a path for oneself, or — as a club admin — for any club member. */
export const addMemberPath = createServerFn({ method: "POST" })
	.validator((i: unknown) => mutateSchema.parse(i))
	.handler(async ({ data }): Promise<MemberEnrollment[]> => {
		const user = await requireUser();
		const { personId } = await resolveEnrollmentAuthz({
			userId: user.id,
			clubId: data.clubId,
			memberId: data.memberId,
		});
		await enrollInPath(personId, data.pathId);
		return listMemberEnrollments(personId);
	});

/** Leave a path. Archives, never deletes — see the logic module for why. */
export const removeMemberPath = createServerFn({ method: "POST" })
	.validator((i: unknown) => mutateSchema.parse(i))
	.handler(async ({ data }): Promise<MemberEnrollment[]> => {
		const user = await requireUser();
		const { personId } = await resolveEnrollmentAuthz({
			userId: user.id,
			clubId: data.clubId,
			memberId: data.memberId,
		});
		await archiveEnrollment(personId, data.pathId);
		return listMemberEnrollments(personId);
	});

/**
 * Server fns for explicit progress marks (#419). Exports ONLY `createServerFn`s
 * and types — the db logic lives in `progress-marks-logic.ts`, because a plain
 * db-touching export here would drag `#/db` → `pg` → `Buffer` into the client
 * bundle and white-screen the page. Enforced by `server-modules.guard.test.ts`.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./guards";
import { type PathViewModel, pathwaysForPerson } from "./pathways-read-logic";
import {
	markProjectComplete,
	resolveMarkAuthz,
	resolveMarkTarget,
	selfMemberIdInClub,
	selfPersonId,
	unmarkProjectComplete,
} from "./progress-marks-logic";

const selfSchema = z.object({
	projectId: z.string().uuid(),
	/** Only used to attribute the mark to a membership; authz is person-level. */
	clubId: z.string().uuid().nullish(),
});

const memberSchema = z.object({
	clubId: z.string().uuid(),
	memberId: z.string().uuid(),
	projectId: z.string().uuid(),
});

/**
 * Self surface — no club needed for authorization, because a mark hangs off a
 * person-level enrollment and a Toastmaster's path follows them across clubs.
 * `clubId` is optional and used only to attribute the mark to a membership.
 */
export const markMyProject = createServerFn({ method: "POST" })
	.validator((i: unknown) => selfSchema.parse(i))
	.handler(async ({ data }): Promise<PathViewModel[]> => {
		const user = await requireUser();
		const personId = await selfPersonId(user.id);
		if (!personId) {
			throw new Error("Your account isn't linked to a club roster yet.");
		}
		const { enrollmentId } = await resolveMarkTarget({
			personId,
			projectId: data.projectId,
		});
		await markProjectComplete({
			enrollmentId,
			projectId: data.projectId,
			markedByMemberId: data.clubId
				? await selfMemberIdInClub(user.id, data.clubId)
				: null,
		});
		return pathwaysForPerson(personId);
	});

export const unmarkMyProject = createServerFn({ method: "POST" })
	.validator((i: unknown) => selfSchema.parse(i))
	.handler(async ({ data }): Promise<PathViewModel[]> => {
		const user = await requireUser();
		const personId = await selfPersonId(user.id);
		if (!personId) {
			throw new Error("Your account isn't linked to a club roster yet.");
		}
		const { enrollmentId } = await resolveMarkTarget({
			personId,
			projectId: data.projectId,
		});
		await unmarkProjectComplete({ enrollmentId, projectId: data.projectId });
		return pathwaysForPerson(personId);
	});

/** Mark a project complete for any member of a club you administer. */
export const markMemberProject = createServerFn({ method: "POST" })
	.validator((i: unknown) => memberSchema.parse(i))
	.handler(async ({ data }): Promise<PathViewModel[]> => {
		const user = await requireUser();
		const { personId, actorMemberId } = await resolveMarkAuthz({
			userId: user.id,
			clubId: data.clubId,
			memberId: data.memberId,
		});
		const { enrollmentId } = await resolveMarkTarget({
			personId,
			projectId: data.projectId,
		});
		await markProjectComplete({
			enrollmentId,
			projectId: data.projectId,
			markedByMemberId: actorMemberId,
		});
		return pathwaysForPerson(personId);
	});

export const unmarkMemberProject = createServerFn({ method: "POST" })
	.validator((i: unknown) => memberSchema.parse(i))
	.handler(async ({ data }): Promise<PathViewModel[]> => {
		const user = await requireUser();
		const { personId } = await resolveMarkAuthz({
			userId: user.id,
			clubId: data.clubId,
			memberId: data.memberId,
		});
		const { enrollmentId } = await resolveMarkTarget({
			personId,
			projectId: data.projectId,
		});
		await unmarkProjectComplete({ enrollmentId, projectId: data.projectId });
		return pathwaysForPerson(personId);
	});

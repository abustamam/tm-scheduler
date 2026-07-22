import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSuperadmin, requireUser } from "./guards";
import {
	getMergePreview,
	listDuplicatePeople,
	searchPeopleForMerge,
} from "./people-logic";
import { mergePeople, mergePeopleSchema } from "./people-merge-logic";

// Superadmin "one human = one Person" merge console (person-identity spec,
// Task 8). Every fn is gated by `requireSuperadmin` server-side. This module
// is imported by client route files, so it must export ONLY createServerFns +
// types — the db logic lives in `people-logic.ts` / `people-merge-logic.ts`.
// See server-modules.guard.test.ts.

/** Every group of 2+ Persons sharing a case-insensitive email. SUPERADMIN-only. */
export const listDuplicatePeopleFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return listDuplicatePeople();
	},
);

/** Free-text (name/email) search for a merge candidate. SUPERADMIN-only. */
export const searchPeople = createServerFn({ method: "GET" })
	.validator((query: unknown) => z.string().parse(query))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return searchPeopleForMerge(data);
	});

const previewSchema = z.object({
	keeperId: z.string().uuid(),
	absorbedId: z.string().uuid(),
});

/** Read-only preview of what a merge would do (block reason + moved counts).
 *  SUPERADMIN-only. */
export const previewMerge = createServerFn({ method: "GET" })
	.validator((input: unknown) => previewSchema.parse(input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return getMergePreview(data.keeperId, data.absorbedId);
	});

/** Irreversibly fuse two Persons into one. SUPERADMIN-only. `actorUserId` is
 *  taken from the authenticated superadmin, not the client, and attributed on
 *  the audit row via `impersonated_by`. */
export const mergePeopleFn = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		mergePeopleSchema.omit({ actorUserId: true }).parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return mergePeople({ ...data, actorUserId: currentUser.id });
	});

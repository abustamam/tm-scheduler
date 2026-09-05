/**
 * Club Officer Training (COT) server fns — the record behind DCP goal 9 (#531).
 * Thin `createServerFn` wrappers ONLY; every query lives in
 * `officer-training-logic.ts` so the Start compiler strips it from the client
 * bundle (`server-modules.guard.test.ts` enforces it).
 *
 * Every fn is gated to clubRole "admin", matching `dcp.ts` and ADR-0019 §4: no
 * officer-position-based authz is introduced, because the President already
 * resolves to "admin" through effective-admin.
 *
 * That arm grants on ANY open `officer_terms` row, so every elected officer is a
 * full admin here and CAN record their own training. Deliberate and unchanged by
 * #531 — the same officer can already toggle goal 9 by hand. What that buys is
 * narrower than "control": goal 9 still has to be APPLIED deliberately rather
 * than moving on its own, but that is a workflow convention, not a gate. There
 * is no President-only check anywhere — `applyTrainingSuggestion` is gated
 * `["admin"]` like the rest, and ADR-0019 §4 is explicit that no
 * officer-position authz is introduced. See `officer-training-logic.ts`'s
 * header; this paragraph used to assert the opposite of its own first sentence.
 *
 * `requireClubRole` → `requireMembership` also carries the `clubs.archived_at`
 * gate, which is why nothing here calls `assertClubNotArchived` separately (same
 * as `dcp.ts`). None of these fns is session-less, so
 * `public-readers-archive-gate.guard.test.ts` classifies them as guarded rather
 * than enrolling them as public readers — which is precisely why the role list
 * needs its own guard (`officer-training-authz.guard.test.ts`): that sweep is
 * satisfied by any `require*` call and cannot see a widened role list.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireClubRole, requireUser } from "./guards";
import {
	addTrainingRecord as addTrainingRecordDb,
	addTrainingRecordSchema,
	getOfficerTrainingSchema,
	getOfficerTrainingView as getOfficerTrainingViewDb,
	removeTrainingRecord as removeTrainingRecordDb,
	removeTrainingRecordSchema,
	resetTrainingWindow as resetTrainingWindowDb,
	resetTrainingWindowSchema,
	setTrainingWindow as setTrainingWindowDb,
	setTrainingWindowSchema,
} from "./officer-training-logic";

export const getOfficerTraining = createServerFn({ method: "GET" })
	.validator((i: unknown) => getOfficerTrainingSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return getOfficerTrainingViewDb(data);
	});

export const setTrainingWindow = createServerFn({ method: "POST" })
	.validator((i: unknown) => setTrainingWindowSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		await setTrainingWindowDb(data);
		return getOfficerTrainingViewDb({
			clubId: data.clubId,
			programYear: data.programYear,
		});
	});

export const resetTrainingWindow = createServerFn({ method: "POST" })
	.validator((i: unknown) => resetTrainingWindowSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		await resetTrainingWindowDb(data);
		return getOfficerTrainingViewDb({
			clubId: data.clubId,
			programYear: data.programYear,
		});
	});

export const addTrainingRecord = createServerFn({ method: "POST" })
	.validator((i: unknown) => addTrainingRecordSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		await addTrainingRecordDb(data, user.id);
		return getOfficerTrainingViewDb({
			clubId: data.clubId,
			programYear: data.programYear,
		});
	});

/**
 * Returns `{ removed, view }` rather than just the flag: every other training
 * write hands back the fresh view, and this one made the client refetch it — a
 * third round trip for one DELETE. `removed` is still surfaced so the caller can
 * stop reporting success for a no-op. It does NOT distinguish "already gone"
 * from "not yours" — both return false, deliberately, because telling them apart
 * would be a cross-club existence oracle. (`officer-training-logic.ts` words
 * this correctly; this sentence used to claim the opposite.)
 */
export const removeTrainingRecord = createServerFn({ method: "POST" })
	.validator((i: unknown) => removeTrainingRecordSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		const { removed } = await removeTrainingRecordDb(data);
		return {
			removed,
			view: await getOfficerTrainingViewDb({
				clubId: data.clubId,
				programYear: data.programYear,
			}),
		};
	});

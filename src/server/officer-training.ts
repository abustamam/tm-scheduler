/**
 * Club Officer Training (COT) server fns — the record behind DCP goal 9 (#531).
 * Thin `createServerFn` wrappers ONLY; every query lives in
 * `officer-training-logic.ts` so the Start compiler strips it from the client
 * bundle (`server-modules.guard.test.ts` enforces it).
 *
 * Every fn is gated to clubRole "admin", matching `dcp.ts` and ADR-0019 §4: the
 * President already resolves to "admin" through effective-admin, so recording
 * officer training introduces no officer-position-based authz — an officer
 * cannot record their own attendance.
 *
 * `requireClubRole` → `requireMembership` also carries the `clubs.archived_at`
 * gate, which is why nothing here calls `assertClubNotArchived` separately (same
 * as `dcp.ts`). None of these fns is session-less, so
 * `public-readers-archive-gate.guard.test.ts` classifies them as guarded rather
 * than enrolling them as public readers.
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

export const removeTrainingRecord = createServerFn({ method: "POST" })
	.validator((i: unknown) => removeTrainingRecordSchema.parse(i))
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireClubRole(user.id, data.clubId, ["admin"]);
		return removeTrainingRecordDb(data);
	});

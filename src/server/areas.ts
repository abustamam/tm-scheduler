import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { loadAreaHealth } from "./area-health-logic";
import { loadAreaVisits } from "./area-visits-logic";
import {
	addAreaClub as addAreaClubLogic,
	addAreaClubSchema,
	areaClubIdSchema,
	areaIdSchema,
	assignAreaDirector as assignAreaDirectorLogic,
	assignAreaDirectorSchema,
	createArea as createAreaLogic,
	createAreaSchema,
	createDistrict as createDistrictLogic,
	createDistrictSchema,
	createDivision as createDivisionLogic,
	createDivisionSchema,
	endAreaDirectorTerm as endAreaDirectorTermLogic,
	endAreaDirectorTermSchema,
	findUserForDirector as findUserForDirectorLogic,
	findUserForDirectorSchema,
	getConsoleArea as getConsoleAreaLogic,
	linkAreaClub as linkAreaClubLogic,
	listConsoleAreas as listConsoleAreasLogic,
	removeAreaClub as removeAreaClubLogic,
	renameArea as renameAreaLogic,
	renameAreaSchema,
	renameDivision as renameDivisionLogic,
	renameDivisionSchema,
} from "./areas-logic";
import { requireSuperadmin, requireUser } from "./guards";

// The superadmin console's area hierarchy (#1116, part of #1115): districts,
// divisions, areas, the clubs in each area and the Area Director. EVERY fn here
// runs `requireUser()` then `requireSuperadmin()` before it touches the logic,
// and `areas-authz.guard.test.ts` pins that order for each one. The logic in
// `areas-logic.ts` has no session of its own and trusts these handlers.
//
// This module is imported by client route files, so it exports ONLY
// createServerFns (server-modules.guard.test.ts); the db logic and the zod
// schemas live in `areas-logic.ts`.

/**
 * zod's own `.parse` throws an Error whose message is a JSON array of issues,
 * which a toast would print verbatim. The first issue's message is the
 * sentence the schema was written to say.
 */
function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
	const result = schema.safeParse(input);
	if (!result.success) {
		throw new Error(result.error.issues[0]?.message ?? "Invalid input");
	}
	return result.data;
}

/** Districts → divisions (newest year first) → areas, with club and director counts. */
export const listConsoleAreas = createServerFn({ method: "GET" }).handler(
	async () => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return listConsoleAreasLogic();
	},
);

/** One area: its clubs (linked or not), current director and past terms. */
export const getConsoleArea = createServerFn({ method: "GET" })
	.validator((input: unknown) => parse(areaIdSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return getConsoleAreaLogic(data.areaId);
	});

/**
 * An area's health as its Area Director sees it (#1119), for the console's
 * "Preview as Area Director". The same loader `getAreaHealth` runs, behind the
 * superadmin gate instead of the director's: a superadmin with no term is
 * refused by `getAreaHealth` (ADR-0016 section 4) and reads the numbers here.
 * Returns the visit dates too (#1120), read-only: the superadmin cannot call
 * the visit endpoints.
 */
export const previewConsoleArea = createServerFn({ method: "GET" })
	.validator((input: unknown) => parse(areaIdSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		const health = await loadAreaHealth(data.areaId);
		const visits = await loadAreaVisits(data.areaId);
		return { health, visits };
	});

export const createDistrict = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(createDistrictSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return createDistrictLogic(data);
	});

/** A division's year must be the current program year or the next one. */
export const createDivision = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(createDivisionSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return createDivisionLogic(data);
	});

export const createArea = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(createAreaSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return createAreaLogic(data);
	});

export const renameDivision = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(renameDivisionSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return renameDivisionLogic(data);
	});

export const renameArea = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(renameAreaSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return renameAreaLogic(data);
	});

/** Either `{ clubId }` (copies the club's name and number) or `{ name, clubNumber? }`. */
export const addAreaClub = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(addAreaClubSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return addAreaClubLogic(data);
	});

/** Link a name-only row to the GavelUp club with the same club number. */
export const linkAreaClub = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(areaClubIdSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return linkAreaClubLogic(data);
	});

/** Refused with "This club has recorded visits" once a visit exists. */
export const removeAreaClub = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(areaClubIdSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return removeAreaClubLogic(data);
	});

/** Exact, case-insensitive match on a VERIFIED email; null when none. A POST,
 *  not a GET: a GET would put a third party's email address in the URL, and so
 *  in every access log and browser history on the way. */
// Read-shaped on purpose: waived in `club-logo-method.guard.test.ts` (POST_WAIVERS).
export const findUserForDirector = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(findUserForDirectorSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return findUserForDirectorLogic(data);
	});

/** Opens a term; refused with "End the current term first" while one is open.
 *  `assignedBy` is the signed-in superadmin, never a client field. */
export const assignAreaDirector = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(assignAreaDirectorSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return assignAreaDirectorLogic(data, currentUser.id);
	});

/** Closes a term. `endedBy` is the signed-in superadmin, never a client field. */
export const endAreaDirectorTerm = createServerFn({ method: "POST" })
	.validator((input: unknown) => parse(endAreaDirectorTermSchema, input))
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireSuperadmin(currentUser.id);
		return endAreaDirectorTermLogic(data, currentUser.id);
	});

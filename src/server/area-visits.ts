import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { NO_PERMISSION_MESSAGE } from "#/lib/permission-message";
import { requireAreaDirector } from "./area-guards";
import {
	areaClubSummarySchema,
	areaIdOfAreaClub,
	clearClubVisit as clearClubVisitLogic,
	clearClubVisitSchema,
	loadAreaClubSummary,
	recordClubVisit as recordClubVisitLogic,
	recordClubVisitSchema,
	VISIT_LOAD_FAILED_MESSAGE,
	VISIT_SAVE_FAILED_MESSAGE,
	visitFailure,
} from "./area-visits-logic";
import { requireUser } from "./guards";

// The Area Director's club visits (#1120, part of #1115, ADR-0032): record a
// visit's date and round, clear it, and read one club's one-page summary.
//
// Each fn runs `requireUser()`, then `requireAreaDirector(user.id, <the area>)`,
// then the logic, and `area-visits-authz.guard.test.ts` pins that order. For the
// two writes the area is RESOLVED FROM THE CLUB (`areaIdOfAreaClub`): the input
// carries no area id for a client to pair with another area's club. The gate
// here is the fast refusal; the writes re-ask it under a lock inside their
// transaction (`requireAreaDirectorTx`), which is what stops a term that ended
// a moment ago from authorizing a write that commits after. A superadmin with no
// term is refused by all three (ADR-0016 section 4). Not reachable from
// `/api/mcp`: no file under `src/server/mcp/` may import this module.
//
// Each handler answers only what it wrote: the no-permission refusal and the
// visit rules' own sentences reach the person; any other failure is logged and
// becomes a fixed one, never a raw `Failed query … params` (`visitFailure`).
//
// This module is imported by client route files, so it exports ONLY
// createServerFns (server-modules.guard.test.ts); the logic and the zod schemas
// live in `area-visits-logic.ts`.

/**
 * An id that is not one the guard could look up (missing, not a string, past
 * the length cap) gets the standard refusal, never a schema message: a
 * malformed link is not told apart from a club the caller may not touch. Any
 * other schema failure (a bad date or round) says what the schema was written
 * to say.
 */
function parse<S extends z.ZodType>(
	schema: S,
	input: unknown,
	idKeys: string[],
): z.output<S> {
	const result = schema.safeParse(input);
	if (!result.success) {
		const issue = result.error.issues[0];
		const onId =
			issue === undefined ||
			issue.path.length === 0 ||
			idKeys.includes(String(issue.path[0]));
		throw new Error(onId ? NO_PERMISSION_MESSAGE : issue.message);
	}
	return result.data;
}

/** Record round 1 or 2 of a club's visit, or edit it: one row per round. */
export const recordClubVisit = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(recordClubVisitSchema, input, ["areaClubId"]),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		try {
			const areaId = await areaIdOfAreaClub(data.areaClubId);
			await requireAreaDirector(user.id, areaId);
			return await recordClubVisitLogic(user.id, areaId, data);
		} catch (err) {
			throw visitFailure(err, VISIT_SAVE_FAILED_MESSAGE);
		}
	});

/** Clear one round's visit. */
export const clearClubVisit = createServerFn({ method: "POST" })
	.validator((input: unknown) =>
		parse(clearClubVisitSchema, input, ["areaClubId"]),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		try {
			const areaId = await areaIdOfAreaClub(data.areaClubId);
			await requireAreaDirector(user.id, areaId);
			return await clearClubVisitLogic(user.id, areaId, data);
		} catch (err) {
			throw visitFailure(err, VISIT_SAVE_FAILED_MESSAGE);
		}
	});

/**
 * One club's summary for the print page: its numbers and both visit dates. The
 * club must be in `areaId`; another area's club is the same refusal as one that
 * does not exist.
 */
export const getAreaClubSummary = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		parse(areaClubSummarySchema, input, ["areaId", "areaClubId"]),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		try {
			await requireAreaDirector(user.id, data.areaId);
			return await loadAreaClubSummary(data.areaId, data.areaClubId);
		} catch (err) {
			throw visitFailure(err, VISIT_LOAD_FAILED_MESSAGE);
		}
	});

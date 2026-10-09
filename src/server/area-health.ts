import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { NO_PERMISSION_MESSAGE } from "#/lib/permission-message";
import { requireAreaDirector } from "./area-guards";
import { loadAreaView } from "./area-visits-logic";
import { requireUser } from "./guards";

// The Area Director's read (#1119, part of #1115, ADR-0032): an area's health
// as counts, rates and dates, and nothing about any person.
//
// `requireUser()` then `requireAreaDirector(user.id, areaId)` then the loader,
// in that order, and `area-access.guard.test.ts` pins it. The loader has no
// session of its own and trusts this handler. Not reachable from `/api/mcp`:
// no file under `src/server/mcp/` may import this module.
//
// This module is imported by client route files, so it exports ONLY
// createServerFns (server-modules.guard.test.ts); the guard and the loader live
// in `area-guards.ts` and `area-health-logic.ts`.

const areaHealthInput = z.object({ areaId: z.string().max(100) });

/**
 * One area's health and its clubs' recorded visits (#1120), for a user with a current Area Director term on it.
 * Anyone else, including a superadmin with no term, gets the standard refusal.
 * So does ANY input that is not an area id the guard could look up: a missing
 * or non-string id, one past the length cap, one that is not a uuid (the guard
 * checks that). A malformed URL is never told apart from an area the caller may
 * not read, and never reaches the error boundary as a schema message.
 */
export const getAreaHealth = createServerFn({ method: "GET" })
	.validator((input: unknown) => {
		const parsed = areaHealthInput.safeParse(input);
		if (!parsed.success) throw new Error(NO_PERMISSION_MESSAGE);
		return parsed.data;
	})
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireAreaDirector(user.id, data.areaId);
		return loadAreaView(data.areaId);
	});

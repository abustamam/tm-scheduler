import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAreaDirector } from "./area-guards";
import { loadAreaHealth } from "./area-health-logic";
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
 * One area's health, for a user with a current Area Director term on it.
 * Anyone else, including a superadmin with no term, gets the standard refusal.
 * The id is checked as a uuid by the guard, not here, so a malformed URL gets
 * that same refusal and is not told apart from an area the caller may not read.
 */
export const getAreaHealth = createServerFn({ method: "GET" })
	.validator((input: unknown) => {
		const parsed = areaHealthInput.safeParse(input);
		if (!parsed.success) {
			throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
		}
		return parsed.data;
	})
	.handler(async ({ data }) => {
		const user = await requireUser();
		await requireAreaDirector(user.id, data.areaId);
		return loadAreaHealth(data.areaId);
	});

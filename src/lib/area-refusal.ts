/**
 * Is this error the Area Director guard's refusal (#1119)? The area page maps
 * it to the standard not-found, so a person with no term on an area (and a
 * mistyped or stale link) is told no more than "that page doesn't exist": the
 * answer never says whether the area does.
 *
 * Client-safe: the guard's message lives in `server/guards.ts`, which reaches
 * `#/db` and cannot be imported by a route. `area-access.guard.test.ts` reads
 * that file and fails if this copy drifts from it.
 */
export const AREA_REFUSAL_MESSAGE = "You don't have permission to do that.";

export function isAreaRefusal(err: unknown): boolean {
	return err instanceof Error && err.message === AREA_REFUSAL_MESSAGE;
}

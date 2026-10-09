import { NO_PERMISSION_MESSAGE } from "#/lib/permission-message";

/**
 * Is this error the Area Director guard's refusal (#1119)? The area page maps
 * it to the standard not-found, so a person with no term on an area (and a
 * mistyped or stale link) is told no more than "that page doesn't exist": the
 * answer never says whether the area does.
 *
 * Reads the guard's own message from `permission-message.ts`, the one place it
 * is declared, so it cannot drift from what `requireAreaDirector` throws.
 */
export function isAreaRefusal(err: unknown): boolean {
	return err instanceof Error && err.message === NO_PERMISSION_MESSAGE;
}

/**
 * The bounds and the normaliser for the club-level schedule columns (#1514):
 * the default meeting length and the free-text schedule line. No db import, so
 * the MCP tool's plan and the sparse write in `clubs-logic.ts` share ONE
 * definition and the plan can never predict a value the write would store
 * differently.
 */

/** A day is the longest a meeting can be; also keeps the integer column safe. */
export const MAX_DEFAULT_MEETING_MINUTES = 1440;

/** The longest schedule line, in characters, after nothing is trimmed away. */
export const MAX_SCHEDULE_TEXT_CHARS = 200;

/**
 * The stored form of a schedule line: trimmed, and null when nothing is left
 * (blank and whitespace-only text clear the line, like an explicit null).
 */
export function normalizeScheduleText(
	text: string | null | undefined,
): string | null {
	const trimmed = text?.trim() ?? "";
	return trimmed.length === 0 ? null : trimmed;
}

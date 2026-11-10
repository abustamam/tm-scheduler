/**
 * Numeric ceilings of the `edit_speaker_slots` MCP tool (#1576).
 *
 * They live here, not in `tools/edit-speaker-slots.ts`, because that module
 * imports `#/db` at load and a test could then not import the constants without
 * a database (`CODING_STANDARDS.md`, "Test coverage").
 */

/** Speakers added or removed in one call. A meeting has a handful; this bounds
 *  how long the meeting row stays locked. */
export const MAX_SPEAKER_COUNT = 5;

/** Moves per list (`moveSpeakers`, `moveEvaluators`) in one call. */
export const MAX_MOVES = 20;

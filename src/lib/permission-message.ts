/**
 * The refusal every permission guard throws (`NO_PERMISSION_MESSAGE`), declared
 * once. Lives in `src/lib` (no `#/db` import) so the server guards and a client
 * route that maps the refusal to a page (`area-refusal.ts`, the Area Director's
 * not-found) read the SAME string, as `club-archive.ts` does for the archive
 * message. `server/guards.ts` re-exports it unchanged for every existing caller.
 */
export const NO_PERMISSION_MESSAGE = "You don't have permission to do that.";

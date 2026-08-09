/**
 * In-page anchor ids on the meeting view. Shared constants so the toolbar's
 * jump links and the route's section ids cannot drift apart (#541) — a
 * renamed id would otherwise leave the completed-phase primary pointing at
 * nothing, silently (a string href is invisible to typecheck).
 */
export const MINUTES_ANCHOR_ID = "minutes";

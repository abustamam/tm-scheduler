/**
 * In-page anchor ids on the meeting view. Shared constants so the toolbar's
 * jump links and the route's section ids cannot drift apart (#541) — a
 * renamed id would otherwise leave the completed-phase primary pointing at
 * nothing, silently (a string href is invisible to typecheck).
 *
 * The scroll itself is TanStack's hash handling, which only runs because
 * `src/router.tsx` sets `scrollRestoration: true` — turning that off silently
 * stops the Minutes primary from scrolling, with every test green.
 */
export const MINUTES_ANCHOR_ID = "minutes";

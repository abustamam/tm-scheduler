import type { MeetingPhase } from "#/lib/meeting-lifecycle";

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

/**
 * THE gate for the completed-phase Minutes primary AND its anchor target.
 * One definition, both sides: the toolbar renders the CTA with it, the route
 * renders the anchor section (real or degrade-fallback) with it. Spelled out
 * twice, these drifted invisibly — the guard test counts anchor occurrences
 * but is structurally blind to condition divergence (#541 review).
 */
export function showsMinutesPrimary(
	phase: MeetingPhase,
	canManage: boolean,
): boolean {
	return phase === "completed" && canManage;
}

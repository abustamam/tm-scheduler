import type { AgendaLayout } from "#/components/agenda/meeting-agenda-print";

/**
 * App-relative path to the clean, read-only ("bare") agenda print view for
 * sharing (#334): the layout is locked in and the on-screen editing chrome (the
 * layout selector, offline badge, and timing banner) is hidden via `chrome=none`.
 *
 * `clubId` / `meetingId` are passed straight through from the current print
 * route params, so post-#336 the link is the pretty date-based URL (and a raw
 * uuid still resolves). Pair with `<ShareLinkButton path={…} />`, which prepends
 * the current origin at click time. All segments are URL-safe (slug / date-key /
 * uuid / a fixed layout enum), so no escaping is needed.
 */
export function buildAgendaSharePath(
	clubId: string,
	meetingId: string,
	layout: AgendaLayout,
): string {
	return `/club/${clubId}/meeting/${meetingId}/print?layout=${layout}&chrome=none`;
}

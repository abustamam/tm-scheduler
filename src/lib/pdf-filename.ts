/**
 * The printables this basename can name. Add a case when you add a print route
 * that relies on `<title>` for its saved filename.
 *
 * Two deliberate non-callers:
 *   • The minutes and role-sheet PDF *API endpoints* generate the file server
 *     side and build their own `content-disposition` names, so `<title>` never
 *     enters into it.
 *   • The role-sheet *print route* (`routes/club.$clubId_.roles.tsx`) DOES rely
 *     on `<title>` for its saved filename, and still hand-rolls
 *     `${club.name} — Meeting Roles`. That is not an oversight: it is
 *     club-scoped, not meeting-scoped, so it has no meeting date to name and
 *     `meetingPdfBasename` does not fit it.
 */
export type PdfArtifact = "meeting" | "word-of-the-day";

/**
 * Filename-safe basename for a meeting's printable/downloadable PDF, e.g.
 * "Downtown-Toastmasters-meeting-2026-07-22". When a print page is saved as PDF,
 * browsers derive the filename from `document.title`, so the agenda print route
 * and the Word of the Day poster use this as their <title>; a future server-generated
 * agenda PDF permalink can reuse it for the `content-disposition` filename.
 *
 * - Club name is slugified: case preserved, runs of non-alphanumerics collapse
 *   to a single "-", leading/trailing "-" trimmed. Empty/punctuation-only ⇒
 *   "club" — artifact-neutral, because `artifact` already names the printable.
 * - `artifact` names the printable between the club slug and the date (defaults to
 *   "meeting" for agendas). Pass "word-of-the-day" for the Word of the Day poster
 *   so its saved file is not mistaken for an agenda.
 * - Date is the meeting's calendar day in the club's timezone, ISO "YYYY-MM-DD"
 *   (sortable and locale-independent).
 */
export function meetingPdfBasename(
	clubName: string,
	scheduledAt: Date | string,
	timeZone?: string,
	artifact: PdfArtifact = "meeting",
): string {
	return `${slugifyClubName(clubName)}-${artifact}-${isoDateInTimeZone(scheduledAt, timeZone)}`;
}

/**
 * Collapse anything that isn't a letter or number (any script) to a single "-".
 *
 * The fallback names the CLUB slot, not an artifact: "agenda" here produced
 * "agenda-word-of-the-day-2026-07-31" for a punctuation-only club name — the
 * exact "mistaken for an agenda" outcome the `artifact` segment exists to
 * prevent.
 */
function slugifyClubName(name: string): string {
	const slug = name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
	return slug || "club";
}

/** The instant's calendar day in `timeZone` as ISO "YYYY-MM-DD". */
function isoDateInTimeZone(value: Date | string, timeZone?: string): string {
	const d = typeof value === "string" ? new Date(value) : value;
	const parts = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		timeZone,
	}).formatToParts(d);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")}`;
}

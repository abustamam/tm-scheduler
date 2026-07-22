/**
 * Filename-safe basename for a meeting's printable/downloadable PDF, e.g.
 * "Downtown-Toastmasters-meeting-2026-07-22". When a print page is saved as PDF,
 * browsers derive the filename from `document.title`, so the agenda print route
 * uses this as its <title>; a future server-generated agenda PDF permalink can
 * reuse it for the `content-disposition` filename.
 *
 * - Club name is slugified: case preserved, runs of non-alphanumerics collapse
 *   to a single "-", leading/trailing "-" trimmed. Empty/punctuation-only ⇒
 *   "agenda".
 * - Date is the meeting's calendar day in the club's timezone, ISO "YYYY-MM-DD"
 *   (sortable and locale-independent).
 */
export function meetingPdfBasename(
	clubName: string,
	scheduledAt: Date | string,
	timeZone?: string,
): string {
	return `${slugifyClubName(clubName)}-meeting-${isoDateInTimeZone(scheduledAt, timeZone)}`;
}

/** Collapse anything that isn't a letter or number (any script) to a single "-". */
function slugifyClubName(name: string): string {
	const slug = name.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
	return slug || "agenda";
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

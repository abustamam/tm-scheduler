/**
 * Turn a stored announcements/reminders blob into display lines: split on
 * newlines, trim each, and drop blank lines. Shared by the on-screen agenda and
 * the printed agenda so both render an identical clean list. Present mode keeps
 * its own blank-line-as-spacer behavior in `slide-layout.ts` — deliberately not
 * this.
 */
export function announcementLines(text: string | null | undefined): string[] {
	if (!text) return [];
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

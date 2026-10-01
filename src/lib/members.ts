import { APP_LOCALE } from "#/lib/format";

/** The calendar year and month (1-12) of `d` on the wall clock of `timeZone`. */
function yearMonthIn(d: Date, timeZone: string): { y: number; m: number } {
	const parts = new Intl.DateTimeFormat(APP_LOCALE, {
		year: "numeric",
		month: "numeric",
		timeZone,
	}).formatToParts(d);
	const num = (type: "year" | "month") =>
		Number(parts.find((p) => p.type === type)?.value);
	return { y: num("year"), m: num("month") };
}

/**
 * Short tenure string from a join date, e.g. "3 yrs" / "8 mo" / "6 wks".
 *
 * Months are counted on the calendar of `timeZone`, never the runtime's own
 * (#1017). This used to read `getFullYear()` / `getMonth()`, which answer in
 * whichever process is rendering: across a month boundary a UTC server and a
 * browser in Los Angeles disagree on what month it is, so the two passes
 * printed different tenures and React threw the server markup away. On the 1st
 * of every month that was 00:00-08:00 UTC on every row of the VPE dashboard.
 *
 * Pass the club's zone and a `now` that both passes share (a loader-pinned
 * instant). Omitted, the zone is UTC: a fixed zone at least makes the server
 * and the browser agree, which the runtime's zone cannot.
 */
export function formatTenure(
	joinedAt: Date | string,
	options: { now?: Date; timeZone?: string } = {},
): string {
	const j = typeof joinedAt === "string" ? new Date(joinedAt) : joinedAt;
	const { now = new Date(), timeZone = "UTC" } = options;
	const a = yearMonthIn(j, timeZone);
	const b = yearMonthIn(now, timeZone);
	const months = (b.y - a.y) * 12 + (b.m - a.m);
	if (months < 1) {
		const weeks = Math.max(
			1,
			Math.round((now.getTime() - j.getTime()) / 6048e5),
		);
		return `${weeks} wk${weeks === 1 ? "" : "s"}`;
	}
	if (months < 12) {
		return `${months} mo`;
	}
	const years = Math.floor(months / 12);
	return `${years} yr${years === 1 ? "" : "s"}`;
}

/** True when a member joined within the last ~90 days (the only "status" we can derive). */
export function isNewMember(joinedAt: Date | string): boolean {
	const j = typeof joinedAt === "string" ? new Date(joinedAt) : joinedAt;
	return Date.now() - j.getTime() < 90 * 24 * 60 * 60 * 1000;
}

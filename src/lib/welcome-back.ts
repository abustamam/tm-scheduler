import { APP_LOCALE } from "./format";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The roll's "Welcome back" toast (#1446). More than 28 days since the last
 * meeting reads as a month name ("since August"), otherwise as the day
 * ("since Oct 8"); never present since joining reads "since joining".
 */
export function welcomeBackMessage(
	name: string,
	lastPresentAt: Date | string | null,
	now: Date,
	timeZone?: string,
): string {
	const first = name.trim().split(/\s+/)[0] || name;
	if (lastPresentAt === null) {
		return `Welcome back, ${first}: first meeting since joining`;
	}
	const last =
		typeof lastPresentAt === "string" ? new Date(lastPresentAt) : lastPresentAt;
	const long = now.getTime() - last.getTime() > 28 * DAY_MS;
	const since = new Intl.DateTimeFormat(
		APP_LOCALE,
		long
			? { month: "long", timeZone }
			: { month: "short", day: "numeric", timeZone },
	).format(last);
	return `Welcome back, ${first}: first meeting since ${since}`;
}

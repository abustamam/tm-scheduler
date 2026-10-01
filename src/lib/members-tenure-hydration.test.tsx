// @vitest-environment jsdom
//
// #1017: `formatTenure` counted months with the runtime's local
// `getFullYear()` / `getMonth()`, so across a MONTH boundary the UTC server and
// a browser in Los Angeles disagreed on what month it was and printed different
// tenures. It renders on every VPE dashboard row and on a member's profile, so
// between 00:00 and 08:00 UTC on the 1st of each month those pages threw React
// #418 in production. The route gate runs mid-month on purpose, so nothing else
// sees this; these cases are pinned to the boundary.
//
// The seam the old code read is the process zone (`TZ`), which the Date getters
// answer in, plus `Intl`'s default zone, which `pinIntlTo` moves. Both are
// shifted between the server render and the hydration.
import { afterEach, describe, expect, it } from "vitest";
import { formatTenure } from "#/lib/members";
import {
	hydrateAcrossRuntimes,
	pinIntlTo,
	restoreIntl,
} from "#/test/hydration-across-runtimes";

const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
	restoreIntl();
	if (ORIGINAL_TZ === undefined) delete process.env.TZ;
	else process.env.TZ = ORIGINAL_TZ;
});

/** 03:30 UTC on Oct 1: already October in UTC, still Sep 30 in Los Angeles. */
const NOW = new Date("2026-10-01T03:30:00Z");
/** Mid-October 2025, so the month count is 12 in UTC and 11 in LA. */
const JOINED = new Date("2025-10-15T18:00:00Z");
const CLUB_ZONE = "America/Los_Angeles";

const SERVER = () => {
	process.env.TZ = "UTC";
	pinIntlTo("en-US", "UTC");
};
const BROWSER = () => {
	process.env.TZ = "America/Los_Angeles";
	pinIntlTo("es-ES", "America/Los_Angeles");
};

/** `formatTenure` as it stood before #1017: the runtime's calendar. */
function legacyTenure(joinedAt: Date, now: Date): string {
	const months =
		(now.getFullYear() - joinedAt.getFullYear()) * 12 +
		(now.getMonth() - joinedAt.getMonth());
	if (months < 12) return `${months} mo`;
	const years = Math.floor(months / 12);
	return `${years} yr${years === 1 ? "" : "s"}`;
}

// Components, not elements: an element's text is computed when it is CREATED,
// before either runtime is installed, so both passes would get one string.
function Legacy() {
	return <span>{legacyTenure(JOINED, NOW)}</span>;
}
function InClubZone() {
	return <span>{formatTenure(JOINED, { now: NOW, timeZone: CLUB_ZONE })}</span>;
}
function NoZone() {
	return <span>{formatTenure(JOINED, { now: NOW })}</span>;
}

describe("formatTenure across a month boundary (#1017)", () => {
	it("CONTROL: on the runtime's calendar, the two passes mismatch", () => {
		expect(
			hydrateAcrossRuntimes(<Legacy />, SERVER, BROWSER),
			"the harness no longer reproduces a month-boundary mismatch",
		).not.toEqual([]);
	});

	it("in the club's zone, hydrates clean and counts the club's months", () => {
		expect(hydrateAcrossRuntimes(<InClubZone />, SERVER, BROWSER)).toEqual([]);
		// Still Sep 30 in Los Angeles: 11 months, not the UTC server's year.
		expect(formatTenure(JOINED, { now: NOW, timeZone: CLUB_ZONE })).toBe(
			"11 mo",
		);
	});

	it("with no zone, counts in UTC whichever runtime renders", () => {
		expect(hydrateAcrossRuntimes(<NoZone />, SERVER, BROWSER)).toEqual([]);
		BROWSER();
		expect(formatTenure(JOINED, { now: NOW })).toBe("1 yr");
	});

	it("reads `now` from the caller, not the process clock", () => {
		expect(
			formatTenure(JOINED, {
				now: new Date("2025-11-20T12:00:00Z"),
				timeZone: CLUB_ZONE,
			}),
		).toBe("1 mo");
		expect(
			formatTenure(JOINED, {
				now: new Date("2025-10-29T18:00:00Z"),
				timeZone: CLUB_ZONE,
			}),
		).toBe("2 wks");
	});
});

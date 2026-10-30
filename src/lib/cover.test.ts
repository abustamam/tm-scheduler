import { describe, expect, it } from "vitest";
import {
	buildCoverAsk,
	buildCoverCall,
	coveredStory,
	coverLink,
	coverStatus,
	isLateDrop,
	LATE_DROP_HOURS,
} from "./cover";

const HOUR = 3_600_000;

describe("isLateDrop", () => {
	const meeting = new Date("2026-11-05T01:00:00Z");

	it("is late inside the window and not outside it", () => {
		// protects=the 48h rule that decides whether a decline writes a `dropped` row
		// fails_when=the threshold moves, or the comparison flips direction
		// no_claim=what the decline paths do with the answer
		expect(isLateDrop(meeting, new Date(meeting.getTime() - 47 * HOUR))).toBe(
			true,
		);
		expect(isLateDrop(meeting, new Date(meeting.getTime() - 49 * HOUR))).toBe(
			false,
		);
		expect(LATE_DROP_HOURS).toBe(48);
	});

	it("is not late once the meeting has started", () => {
		// protects=nobody is asked to cover a meeting already under way
		// fails_when=the lower bound (`ms > 0`) is dropped
		// no_claim=the roll Absent release, which never asks
		expect(isLateDrop(meeting, new Date(meeting.getTime() + 60_000))).toBe(
			false,
		);
	});
});

describe("coverStatus", () => {
	const open = { kind: "finding_cover" as const, coveredAt: null };

	it("flips finding_cover to dropped at 06:00 on the meeting day, Chicago", () => {
		// protects=the derived flip is club-local (CST, UTC-6): 06:00 is 12:00Z
		// fails_when=the flip reads UTC, or the hour changes
		// no_claim=daylight-saving transitions
		const meeting = { scheduledAt: new Date("2026-11-05T01:00:00Z") }; // Wed 19:00 CST
		const tz = "America/Chicago";
		expect(
			coverStatus(open, meeting, tz, new Date("2026-11-04T11:59:00Z")),
		).toBe("finding_cover");
		expect(
			coverStatus(open, meeting, tz, new Date("2026-11-04T12:00:00Z")),
		).toBe("dropped");
	});

	it("flips at 06:00 on the meeting day in Tokyo, a day ahead of UTC", () => {
		// protects=the meeting DAY is the club-local one: 19:00 JST on the 4th is
		//   10:00Z on the 4th, and 06:00 JST on the 4th is 21:00Z on the 3rd
		// fails_when=the day is taken from the UTC date or the zone is ignored
		// no_claim=anything about a second meeting that day
		const meeting = { scheduledAt: new Date("2026-11-04T10:00:00Z") };
		const tz = "Asia/Tokyo";
		expect(
			coverStatus(open, meeting, tz, new Date("2026-11-03T20:59:00Z")),
		).toBe("finding_cover");
		expect(
			coverStatus(open, meeting, tz, new Date("2026-11-03T21:00:00Z")),
		).toBe("dropped");
	});

	it("never flips later than the meeting itself", () => {
		// protects=a 05:00 meeting does not stay "finding cover" past its start
		// fails_when=the `Math.min` against the meeting time is removed
		// no_claim=that anyone runs a 05:00 meeting
		const meeting = { scheduledAt: new Date("2026-11-04T11:00:00Z") }; // 05:00 CST
		expect(
			coverStatus(
				open,
				meeting,
				"America/Chicago",
				new Date("2026-11-04T11:00:00Z"),
			),
		).toBe("dropped");
	});

	it("covered wins, and a dropped row stays dropped", () => {
		// protects=a covered request reads covered even after the flip, and a
		//   `dropped` row never reads finding_cover
		// fails_when=the covered check moves after the kind check, or `dropped`
		//   is ignored
		// no_claim=the hide-after-reassign rule, which is a payload concern
		const meeting = { scheduledAt: new Date("2026-11-05T01:00:00Z") };
		const late = new Date("2026-11-05T02:00:00Z");
		expect(
			coverStatus(
				{ kind: "finding_cover", coveredAt: new Date("2026-11-04T05:00:00Z") },
				meeting,
				"America/Chicago",
				late,
			),
		).toBe("covered");
		expect(
			coverStatus(
				{ kind: "dropped", coveredAt: null },
				meeting,
				"America/Chicago",
				new Date("2026-11-01T00:00:00Z"),
			),
		).toBe("dropped");
	});
});

describe("coveredStory", () => {
	const base = {
		roleLabel: "Timer",
		releasedName: "Sam",
		coveredName: "Priya",
		releasedAt: new Date("2026-11-04T10:00:00Z"),
	};

	it("says minutes, hours and next day", () => {
		// protects=the three phrasings the maintainer specified
		// fails_when=a boundary moves (60 min, 24 h) or the arrow format changes
		// no_claim=localisation
		const at = (ms: number) => new Date(base.releasedAt.getTime() + ms);
		expect(coveredStory({ ...base, coveredAt: at(17 * 60_000) })).toBe(
			"Timer: Sam → Priya · covered in 17 min",
		);
		expect(coveredStory({ ...base, coveredAt: at(3 * HOUR) })).toBe(
			"Timer: Sam → Priya · covered in 3 h",
		);
		expect(coveredStory({ ...base, coveredAt: at(30 * HOUR) })).toBe(
			"Timer: Sam → Priya · covered next day",
		);
	});

	it("never says 0 min for a cover in the same instant", () => {
		// protects=a floor of one minute
		// fails_when=the `Math.max(1, ...)` is removed
		// no_claim=sub-minute precision
		expect(coveredStory({ ...base, coveredAt: base.releasedAt })).toContain(
			"covered in 1 min",
		);
	});
});

describe("coverLink and drafts", () => {
	it("builds the meeting URL with the slot as the cover param", () => {
		// protects=the link shape the meeting page (#1439) reads
		// fails_when=the path or the `cover` param name changes, or a trailing
		//   slash on the origin leaks through
		// no_claim=that the route accepts the param yet
		expect(coverLink("https://gavelup.app/", "mcf", "2026-11-04", "abc")).toBe(
			"https://gavelup.app/club/mcf/meeting/2026-11-04?cover=abc",
		);
	});

	it("both drafts carry the role and the link, and differ in who they address", () => {
		// protects=a draft the member can send without editing
		// fails_when=the role or the link is dropped from either text
		// no_claim=the exact wording
		const link = "https://x.test/club/c/meeting/k?cover=s";
		const ask = buildCoverAsk({ role: "Timer", weekday: "Wednesday", link });
		const call = buildCoverCall({ role: "Timer", when: "Wed Nov 4", link });
		for (const text of [ask, call]) {
			expect(text).toContain("Timer");
			expect(text).toContain(link);
		}
		expect(ask).toContain("Wednesday");
		expect(call).toContain("Wed Nov 4");
		expect(ask).not.toBe(call);
	});
});

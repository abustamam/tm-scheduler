import { describe, expect, it } from "vitest";
import type { Slide } from "./agenda-slides";
import type { NextMeetingRole } from "./next-meeting-summary";
import {
	MAX_OPEN_ROWS,
	MAX_ROSTER_ROWS,
	type RosterRow,
	slideLayout,
	slideName,
} from "./slide-layout";

type NextSlide = Extract<Slide, { kind: "nextMeeting" }>;

const role = (
	label: string,
	names: string[],
	openCount = 0,
): NextMeetingRole => ({
	label,
	names,
	openCount,
});

const slide = (over: Partial<NextSlide> = {}): NextSlide => ({
	kind: "nextMeeting",
	// 6:45 PM Thursday July 9 in Chicago.
	scheduledAt: new Date("2026-07-09T23:45:00Z"),
	timezone: "America/Chicago",
	location: "Library Room B",
	theme: "Momentum",
	meetingNumber: 57,
	toastmaster: role("Toastmaster of the Day", ["Schinthia"]),
	roles: [role("Timer", [], 1), role("Speaker", ["Rehanna"], 2)],
	signupUrl: "https://gavelup.test/club/mcf/meeting/2026-07-09",
	...over,
});

function roster(s: NextSlide) {
	const l = slideLayout(s, null);
	if (l.chrome !== "content" || l.body.form !== "roster")
		throw new Error("expected a roster body");
	return { header: l.header, body: l.body };
}

/** Every role name the slide shows, from rows and collapsed lines alike. */
const shown = (b: ReturnType<typeof roster>["body"]) =>
	[...b.rows.map((r) => r.label), b.filled ?? "", b.openList ?? ""].join(" | ");

describe("the next-meeting slide's layout (#932)", () => {
	it("is headed for the room and named so in the jump grid", () => {
		expect(roster(slide()).header).toBe("What’s on tap for next meeting");
		expect(slideName(slide())).toBe("What’s on tap for next meeting");
	});

	it("leads with date, time and location in the CLUB's timezone", () => {
		const { body } = roster(slide());
		expect(body.when).toBe("Thursday, July 9, 2026 · 6:45 PM · Library Room B");
		// Same instant in another zone is a different wall clock.
		expect(roster(slide({ timezone: "UTC" })).body.when).toContain("11:45 PM");
		expect(roster(slide({ location: null })).body.when).toBe(
			"Thursday, July 9, 2026 · 6:45 PM",
		);
	});

	it("names the Toastmaster, or says Open", () => {
		expect(roster(slide()).body.toastmaster).toEqual({
			label: "Toastmaster of the Day",
			names: "Schinthia",
			open: null,
		});
		expect(
			roster(slide({ toastmaster: role("Toastmaster of the Day", [], 1) })).body
				.toastmaster,
		).toEqual({ label: "Toastmaster of the Day", names: null, open: "Open" });
		expect(roster(slide({ toastmaster: null })).body.toastmaster).toBeNull();
	});

	it("shows the theme and meeting number when set, nothing when not", () => {
		expect(roster(slide()).body.meta).toBe("Meeting #57 · Theme: “Momentum”");
		expect(roster(slide({ theme: null })).body.meta).toBe("Meeting #57");
		expect(
			roster(slide({ theme: null, meetingNumber: null })).body.meta,
		).toBeNull();
	});

	it("lists filled roles with names and open ones with a call to action", () => {
		const rows: RosterRow[] = roster(
			slide({
				roles: [
					role("Timer", [], 1),
					role("Grammarian", ["Mona"]),
					role("Speaker", ["Rehanna"], 2),
					role("Evaluator", [], 3),
				],
			}),
		).body.rows;
		expect(rows).toEqual([
			{ label: "Timer", names: null, open: "Open: grab it tonight!" },
			{ label: "Grammarian", names: "Mona", open: null },
			{ label: "Speaker", names: "Rehanna", open: "+2 open" },
			{ label: "Evaluator", names: null, open: "3 open: grab one tonight!" },
		]);
	});

	it("carries the QR only once the absolute URL is known", () => {
		expect(roster(slide()).body.qr).toEqual({
			url: "https://gavelup.test/club/mcf/meeting/2026-07-09",
			caption: "Scan to grab a role",
		});
		expect(roster(slide({ signupUrl: null })).body.qr).toBeNull();
	});

	describe("fitting every role on one slide", () => {
		const many = (n: number, openEvery: number) =>
			Array.from({ length: n }, (_, i) =>
				i % openEvery === 0
					? role(`Role ${i + 1}`, [], 1)
					: role(`Role ${i + 1}`, [`Person ${i + 1}`]),
			);

		it(`lists every role a row each up to ${MAX_ROSTER_ROWS}`, () => {
			const { body } = roster(slide({ roles: many(MAX_ROSTER_ROWS, 3) }));
			expect(body.rows).toHaveLength(MAX_ROSTER_ROWS);
			expect(body.filled).toBeNull();
			expect(body.openList).toBeNull();
		});

		it("at ~20 roles: open ones keep a row, filled ones collapse to a line", () => {
			const roles = many(20, 5); // 4 open, 16 filled
			const { body } = roster(slide({ roles }));
			expect(body.rows.map((r) => r.label)).toEqual([
				"Role 1",
				"Role 6",
				"Role 11",
				"Role 16",
			]);
			expect(body.rows.every((r) => r.open)).toBe(true);
			expect(body.rows.length).toBeLessThanOrEqual(MAX_OPEN_ROWS);
			// Every filled role is still on the slide, with its holder.
			for (const r of roles.filter((x) => x.openCount === 0)) {
				expect(body.filled).toContain(`${r.label}: ${r.names[0]}`);
			}
		});

		it("never drops or counts away an open role, however many", () => {
			const roles = [
				...Array.from({ length: 20 }, (_, i) => role(`Open ${i + 1}`, [], 1)),
				role("Evaluator", ["Ana"], 2),
			];
			const { body } = roster(slide({ roles }));
			expect(body.rows).toEqual([]);
			for (let i = 1; i <= 20; i++)
				expect(body.openList).toContain(`Open ${i}`);
			expect(body.openList).toContain("Evaluator (2)");
			// A partly filled role keeps its holder on the filled line.
			expect(body.filled).toContain("Evaluator: Ana");
		});

		it("every role appears somewhere in every tier", () => {
			for (const roles of [many(8, 2), many(20, 5), many(20, 1)]) {
				const text = shown(roster(slide({ roles })).body);
				for (const r of roles) expect(text).toContain(r.label);
			}
		});
	});
});

/**
 * The shared speech-log derivations (#656), plus the route wiring that consumes
 * them.
 *
 * ## Why the wiring half is a source grep
 *
 * The bug was never in a component. It was in a route file that rendered the
 * "Completed" badge with no predicate at all, while the sibling route computed
 * one inline — and both of those expressions are invisible to vitest, which is
 * exactly how the two surfaces diverged and stayed diverged. `dashboard.tsx`
 * and `members.$id.tsx` are file-based routes whose components are not
 * exported; rendering either means standing up a router, a session, loader data
 * and half a dozen server fns for one expression. CODING_STANDARDS' "a
 * component tested through its props cannot see a WRONG prop" trap names the
 * reachable gate for that shape, and this is one: a comment-blind source guard
 * that fails on the specific revert.
 *
 * Positive assertions ("this must BE present") read through `readSource`, which
 * blanks comments, so a route comment merely NAMING the pattern cannot produce
 * a false pass. The one negative assertion ("the old inline derivation is
 * gone") reads RAW, per the rule in `src/test/guard-source.ts`: stripping
 * comments there could only LOOSEN it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	SPEECH_SCHEDULE_STATE_LABELS,
	type SpeechScheduleState,
	speechLogHeadline,
	speechScheduleState,
} from "#/lib/speech-schedule-state";
import { isRealSpeechTitle, TBA_SPEECH_TITLE } from "#/lib/speech-title";
import { readSource } from "#/test/guard-source";

/** A fixed instant. Nothing in this file consults the real clock. */
const NOW = new Date("2026-08-10T18:30:00.000Z");
const NOW_MS = NOW.getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const stateAt = (scheduledAt: Date | string | number | null | undefined) =>
	speechScheduleState({ scheduledAt, now: NOW });

describe("speechScheduleState", () => {
	it("calls a meeting that has already happened delivered", () => {
		expect(stateAt(new Date(NOW_MS - 7 * DAY))).toBe("delivered");
	});

	it("calls a meeting still to come scheduled — the #656 bug", () => {
		// Omar's "Data That Persuades": booked for a future meeting, badged
		// "Completed" on the dashboard while the card beside it said "Signed up".
		expect(stateAt(new Date(NOW_MS + 7 * DAY))).toBe("scheduled");
	});

	/**
	 * Both sides of the boundary, one millisecond apart, with the instant
	 * injected — no clock mocking, no timer faking, no flake.
	 */
	it("flips exactly at the comparison instant", () => {
		expect(stateAt(new Date(NOW_MS - 1))).toBe("delivered");
		expect(stateAt(new Date(NOW_MS + 1))).toBe("scheduled");
	});

	/**
	 * The tie goes to "scheduled" so this predicate is the exact complement of
	 * `loadMyCommitments`' `gte(meetings.scheduledAt, now)`. If it went the other
	 * way, a meeting starting on this instant would be BOTH an upcoming role and
	 * a delivered speech — the contradiction the issue is about, reintroduced at
	 * a single point.
	 */
	it("treats a meeting starting exactly now as still scheduled", () => {
		expect(stateAt(new Date(NOW_MS))).toBe("scheduled");
	});

	/**
	 * INSTANT axis, not the club-local DAY axis `meetingDatePassed` uses. A
	 * meeting earlier today has been delivered; one later today has not. Getting
	 * this wrong would leave a row that has plainly happened reading "Scheduled"
	 * until midnight, which is the mirror of the bug being fixed.
	 */
	it("splits a single day at the meeting time, not at midnight", () => {
		expect(stateAt(new Date(NOW_MS - 3 * 60 * MINUTE))).toBe("delivered");
		expect(stateAt(new Date(NOW_MS + 3 * 60 * MINUTE))).toBe("scheduled");
	});

	/**
	 * `SpeechLogRow.scheduledAt` is typed `Date` but is a STRING once the server
	 * fn's payload has crossed the wire — a real Date during the SSR pass, an ISO
	 * string after hydration. Both must classify identically or the badge changes
	 * under the reader at hydration.
	 */
	it("agrees across the wire: Date, ISO string and epoch ms", () => {
		const past = new Date(NOW_MS - DAY);
		expect(stateAt(past)).toBe("delivered");
		expect(stateAt(past.toISOString())).toBe("delivered");
		expect(stateAt(past.getTime())).toBe("delivered");

		const future = new Date(NOW_MS + DAY);
		expect(stateAt(future)).toBe("scheduled");
		expect(stateAt(future.toISOString())).toBe("scheduled");
		expect(stateAt(future.getTime())).toBe("scheduled");
	});

	it("accepts the comparison instant as either a Date or epoch ms", () => {
		const at = new Date(NOW_MS - DAY);
		expect(speechScheduleState({ scheduledAt: at, now: NOW })).toBe(
			speechScheduleState({ scheduledAt: at, now: NOW_MS }),
		);
		expect(speechScheduleState({ scheduledAt: at, now: NOW_MS })).toBe(
			"delivered",
		);
	});

	/**
	 * The asymmetric failure. `new Date("nonsense").getTime()` is `NaN`, and
	 * every comparison against `NaN` is false — so a naive `at < now` would
	 * silently answer "delivered" and assert a talk happened that we have no date
	 * for. Unusable input must never claim delivery.
	 */
	it.each([
		["null", null],
		["undefined", undefined],
		["an unparseable string", "not a date"],
		["an empty string", ""],
		["an Invalid Date", new Date("nonsense")],
		["NaN", Number.NaN],
	])("never claims delivery for %s", (_label, value) => {
		expect(stateAt(value as Date | string | number | null | undefined)).toBe(
			"scheduled",
		);
	});

	/**
	 * The whole point of taking the instant as a parameter (#608's hazard, not
	 * repeated here). If this module ever reads the wall clock, the SSR pass and
	 * the hydration pass can classify one row two ways.
	 */
	it("never reads the wall clock", () => {
		const nowSpy = vi.spyOn(Date, "now");
		try {
			stateAt(new Date(NOW_MS - DAY));
			stateAt(new Date(NOW_MS + DAY));
			stateAt(null);
			expect(nowSpy).not.toHaveBeenCalled();
		} finally {
			nowSpy.mockRestore();
		}
	});

	/** Pure: the same inputs answer the same way however many times you ask. */
	it("is deterministic for a pinned instant", () => {
		const at = new Date(NOW_MS + DAY);
		const answers = new Set([stateAt(at), stateAt(at), stateAt(at)]);
		expect([...answers]).toEqual(["scheduled"]);
	});
});

describe("SPEECH_SCHEDULE_STATE_LABELS", () => {
	/**
	 * The words are the observable — what the member actually reads on the badge
	 * — so they are pinned absolutely rather than compared to themselves.
	 * `delivered` deliberately reads "Completed": ADR-0009's vocabulary for the
	 * derived state and the pill's existing copy are different registers, and the
	 * issue puts restyling (or renaming) the pills out of scope.
	 */
	it("says Scheduled and Completed", () => {
		expect(SPEECH_SCHEDULE_STATE_LABELS.scheduled).toBe("Scheduled");
		expect(SPEECH_SCHEDULE_STATE_LABELS.delivered).toBe("Completed");
	});

	it("labels every state, with no two states sharing a word", () => {
		const states: SpeechScheduleState[] = ["scheduled", "delivered"];
		const labels = states.map((s) => SPEECH_SCHEDULE_STATE_LABELS[s]);
		expect(labels.every((l) => l.length > 0)).toBe(true);
		expect(new Set(labels).size).toBe(states.length);
	});
});

describe("speechLogHeadline", () => {
	it("shows the speech's title when the speaker has named it", () => {
		expect(
			speechLogHeadline({
				speechTitle: "Data That Persuades",
				roleName: "Speaker 1",
			}),
		).toBe("Data That Persuades");
	});

	/**
	 * The sentinel. `speeches.title` is NOT NULL, so "undecided" is stored as the
	 * literal `"TBA"` — the row then headlines itself `TBA` with its project name
	 * underneath, which is what a plain `?? roleName` fallback produces.
	 */
	it("falls back to the role for the stored TBA placeholder", () => {
		expect(
			speechLogHeadline({
				speechTitle: TBA_SPEECH_TITLE,
				roleName: "Speaker 2",
			}),
		).toBe("Speaker 2");
	});

	it("falls back for a padded TBA, which the write path also trims", () => {
		expect(
			speechLogHeadline({ speechTitle: "  TBA  ", roleName: "Speaker 2" }),
		).toBe("Speaker 2");
	});

	it.each([
		["null (no speech row linked at all)", null],
		["undefined", undefined],
		["an empty string", ""],
		["whitespace only", "   "],
	])("falls back to the role for %s", (_label, value) => {
		expect(
			speechLogHeadline({ speechTitle: value, roleName: "Speaker 3" }),
		).toBe("Speaker 3");
	});

	/**
	 * Case is NOT folded, precisely because `isRealSpeechTitle` does not fold it:
	 * a speaker who types a lower-case `tba` has it stored as a real title by the
	 * write path, and disagreeing here would put the log at odds with the agenda.
	 * Pinned so the divergence cannot appear silently.
	 */
	it("treats a lower-case tba as a real title, matching the write path", () => {
		expect(
			speechLogHeadline({ speechTitle: "tba", roleName: "Speaker 4" }),
		).toBe("tba");
	});

	it("trims a real title", () => {
		expect(
			speechLogHeadline({
				speechTitle: "  Ice Breaker  ",
				roleName: "Speaker 5",
			}),
		).toBe("Ice Breaker");
	});

	/**
	 * The one-predicate assertion. Re-deriving "is this filled in" locally is the
	 * recorded trap; this fails the moment the headline stops agreeing with
	 * `isRealSpeechTitle` for any of these shapes, in either direction.
	 */
	it("defers to isRealSpeechTitle rather than re-deriving the rule", () => {
		const candidates = [
			null,
			undefined,
			"",
			"   ",
			TBA_SPEECH_TITLE,
			"  TBA  ",
			"tba",
			"TBAs of the Trade",
			"Data That Persuades",
		];
		for (const speechTitle of candidates) {
			const headline = speechLogHeadline({ speechTitle, roleName: "ROLE" });
			expect(
				headline === "ROLE",
				`headline for ${JSON.stringify(speechTitle)} disagrees with isRealSpeechTitle`,
			).toBe(!isRealSpeechTitle(speechTitle));
		}
	});
});

/**
 * Both speech-log surfaces, wired to the module above. Acceptance criterion:
 * "exactly one implementation of the predicate exists; both surfaces import it.
 * Deleting it fails a test rather than silently reverting one surface."
 */
describe("speech-log route wiring (#656)", () => {
	const ROUTES = {
		dashboard: "src/routes/_authed/dashboard.tsx",
		profile: "src/routes/_authed/members.$id.tsx",
	} as const;
	const entries = Object.entries(ROUTES) as [keyof typeof ROUTES, string][];

	describe.each(entries)("%s (%s)", (_name, path) => {
		/** Comment-blind, for every "must BE present" assertion below. */
		const src = readSource(path);
		/**
		 * Verbatim, for the "must be ABSENT" ones. Stripping comments there could
		 * only remove text an offender sweep might have matched — see the rule in
		 * `src/test/guard-source.ts`.
		 */
		const raw = readFileSync(path, "utf8");

		it("imports the shared derivations", () => {
			expect(src).toMatch(
				/import\s*\{[\s\S]*?\}\s*from\s*"#\/lib\/speech-schedule-state"/,
			);
			expect(src).toMatch(/speechScheduleState/);
			expect(src).toMatch(/speechLogHeadline/);
		});

		/**
		 * The badge must be COMPUTED from the row, not rendered unconditionally.
		 * The dashboard's pill had no predicate at all — this is that revert.
		 */
		it("derives the state from the row's scheduled instant", () => {
			const call = src.match(/speechScheduleState\(\{[\s\S]*?\}\)/);
			expect(call, `no speechScheduleState({…}) call in ${path}`).toBeTruthy();
			expect(call?.[0]).toMatch(/scheduledAt:\s*l\.scheduledAt/);
			expect(call?.[0]).toMatch(/\bnow\b/);
		});

		/** …and the pill must actually receive it. */
		it("renders the badge from that state", () => {
			expect(src).toMatch(/<SpeechStatePill\s+state=\{state\}\s*\/>/);
			expect(src).toMatch(/state === "scheduled"/);
		});

		/**
		 * Both words come from the shared record. A literal on either surface is
		 * how one card came to say "Completed" about a row the other called
		 * "Signed up".
		 */
		it("takes both labels from the shared record", () => {
			expect(src).toMatch(/SPEECH_SCHEDULE_STATE_LABELS\.scheduled/);
			expect(src).toMatch(/SPEECH_SCHEDULE_STATE_LABELS\.delivered/);
		});

		/** The headline goes through the sentinel-aware helper, not `?? roleName`. */
		it("renders the headline through the sentinel-aware helper", () => {
			const call = src.match(/speechLogHeadline\(\{[\s\S]*?\}\)/);
			expect(call, `no speechLogHeadline({…}) call in ${path}`).toBeTruthy();
			expect(call?.[0]).toMatch(/speechTitle:\s*l\.speechTitle/);
			expect(call?.[0]).toMatch(/roleName:\s*l\.roleName/);
			expect(raw).not.toMatch(/l\.speechTitle\s*\?\?\s*l\.roleName/);
		});

		/**
		 * The comparison instant is pinned in the LOADER, so SSR and hydration
		 * classify identically (#608's hazard, not repeated).
		 */
		it("pins the comparison instant in the loader", () => {
			// Assert the MARKER was found, not that the slice is non-empty. With
			// `not.toBe("")` a missing marker makes `indexOf` return -1, `slice(0, -1)`
			// hands back the whole file minus one character, the floor passes, and
			// `now: Date.now()` then matches anywhere in the module — including inside
			// `component:`, which is the one place this test exists to forbid. That is
			// the "counts a PROXY for the thing" trap in CODING_STANDARDS.md.
			const marker = src.indexOf("component:");
			expect(marker, `no "component:" marker in ${path}`).toBeGreaterThan(-1);
			expect(src.slice(0, marker)).toMatch(/now:\s*Date\.now\(\)/);
		});

		/**
		 * RAW, deliberately: this is an "offender list must be empty" assertion,
		 * and reading it comment-blind could only loosen it (see
		 * `src/test/guard-source.ts`). The profile route derived the badge with a
		 * render-time clock read; that expression must not come back on either
		 * surface.
		 */
		it("does not compare against the clock at render time", () => {
			// Both orders and all four operators. The first version pinned only the
			// exact prior spelling (`getTime() > Date.now()`), so `Date.now() < at`
			// — the same defect written the other way round — reintroduced the
			// render-time read silently. An offender sweep that only knows the
			// spelling it was written against is a sweep for one commit.
			expect(raw).not.toMatch(/getTime\(\)\s*[<>]=?\s*Date\.now\(\)/);
			expect(raw).not.toMatch(/Date\.now\(\)\s*[<>]=?\s*[\w.$]*\.?getTime\(\)/);
			expect(raw).not.toMatch(/new Date\([^)]*\)\s*[<>]=?\s*new Date\(\)/);
		});
	});

	/**
	 * The two surfaces must not merely both call the predicate — they must call
	 * it the SAME way. A parity assertion cannot see a defect present on both
	 * sides (CODING_STANDARDS), which is why the golden assertions above sit
	 * beside it rather than being replaced by it.
	 */
	it("classifies with an identical call on both surfaces", () => {
		const normalise = (path: string) =>
			readSource(path)
				.match(/speechScheduleState\(\{[\s\S]*?\}\)/)?.[0]
				.replace(/\s+/g, " ");
		expect(normalise(ROUTES.dashboard)).toBeTruthy();
		expect(normalise(ROUTES.dashboard)).toBe(normalise(ROUTES.profile));
	});
});

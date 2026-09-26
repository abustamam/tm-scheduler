import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Slide } from "#/lib/agenda-slides";
import type { NextMeetingRole } from "#/lib/next-meeting-summary";
import { fitScale } from "#/lib/slide-fit";
import {
	MAX_OPEN_ROWS,
	MAX_ROSTER_ROWS,
	slideLayout,
} from "#/lib/slide-layout";
import {
	CHROME_ENV,
	CHROME_TEST_TIMEOUT_MS,
	findChrome,
} from "#/test/print-page-count";
import { SLIDE_BODY_BOX_1280 } from "#/test/slide-fit-box";
import { NextMeetingBodyView, type RosterBody } from "./next-meeting-body";

/**
 * Whether the "What's on tap for next meeting" slide fits one slide at a
 * realistic worst case (#932) — as a claim about LEGIBILITY, which is the only
 * form of it that can fail.
 *
 * `useFitTransform` scales any body down until it fits the box, so "does it
 * fit" is true of every body by construction; the question is how small it had
 * to get. So this lays the REAL component out — `NextMeetingBodyView`, rendered
 * to static markup, which it can be because it is styled inline in `cqw` rather
 * than by stylesheet classes — inside the deck's measured 1280x720 body box,
 * reads its natural height, and asks `fitScale` what the projector would do.
 *
 * The CONTROL is the same fourteen roles listed a row each, which is what the
 * slide would show without `rosterBody`'s collapsing: it must need a markedly
 * smaller scale, or this suite could not tell the overflow rule from its
 * absence.
 *
 * Fonts: the harness maps every host to NOTFOUND, so Manrope never loads and
 * `CHROME_ENV` pins the fallback face. The floor below carries margin for that.
 */
const hasChrome = findChrome() !== null;

/**
 * The smallest scale the projected slide may need, at a realistic worst case
 * and at each cap.
 *
 * MEASURED against this harness's fallback face, which is wider than Manrope
 * (#932, fonts pinned by `CHROME_ENV`): the worst case needs 0.82, a full row
 * cap (10) 0.85, a full open-row cap (8) plus the filled line 0.85 — and one
 * step past either cap 0.79 / 0.78, the all-rows control 0.70. At 0.80 the
 * 1.8cqw role rows still project at 1.44cqw, about 28px on a 1920px-wide
 * projector.
 */
const MIN_SCALE = 0.8;

const role = (
	label: string,
	names: string[],
	openCount = 0,
): NextMeetingRole => ({
	label,
	names,
	openCount,
});

/** A full standard meeting plus the extras clubs add: fourteen roles past the
 *  Toastmaster, nineteen places counting it, four roles still open. Names are
 *  long on purpose — "Rehanna Khan", not "Ann". */
const WORST: NextMeetingRole[] = [
	role("General Evaluator", ["Saiful Islam"]),
	role("Table Topics Master", [], 1),
	role("Speaker", ["Rehanna Khan", "Sudheer Kumar"], 1),
	role("Evaluator", ["Faisal Ahmed", "Mona Lisa Park"], 1),
	role("Timer", ["Christopher Alvarez"]),
	role("Ah-Counter", ["Jennifer O'Connor"]),
	role("Grammarian", ["Mohammed Rahman"]),
	role("Vote Counter", [], 1),
	role("Joke Master", ["Priya Subramanian"]),
	role("Quiz Master", ["Daniel Okafor"]),
	role("Listener", ["Elizabeth Warren-Smith"]),
	role("Sergeant at Arms", ["Hassan Ali"]),
	role("Photographer", ["Guadalupe Hernandez"]),
	role("Greeter", ["Oluwaseun Adeyemi"]),
];

/** Open roles for the open-row tier, long labels first-come — more of them
 *  than any sane `MAX_OPEN_ROWS`, so raising the cap is measured, not clipped. */
const OPEN_POOL = [
	"Table Topics Master",
	"Sergeant at Arms",
	"General Evaluator",
	"Vote Counter",
	"Speaker",
	"Evaluator",
	"Grammarian",
	"Ah-Counter",
	"Joke Master",
	"Quiz Master",
	"Photographer",
	"Listener",
	"Greeter",
	"Timer",
	"Word Master",
	"Hospitality",
];

/** Eight filled roles with long names, for the collapsed "Also on the agenda"
 *  line beside the open rows. */
const FILLED_EIGHT = WORST.filter(
	(r) => r.openCount === 0 && r.names.length === 1,
).slice(0, 8);

const slide = (
	roles: NextMeetingRole[],
): Extract<Slide, { kind: "nextMeeting" }> => ({
	kind: "nextMeeting",
	scheduledAt: new Date("2026-07-09T23:45:00Z"),
	timezone: "America/Chicago",
	location: "Downtown Public Library, Meeting Room B",
	theme: "Finding Your Momentum",
	meetingNumber: 1057,
	toastmaster: role("Toastmaster of the Day", ["Schinthia Rahman"]),
	roles,
	signupUrl: "https://gavelup.app/club/mcf-toastmasters/meeting/2026-07-09",
});

function bodyOf(roles: NextMeetingRole[]): RosterBody {
	const l = slideLayout(slide(roles), null);
	if (l.chrome !== "content" || l.body.form !== "roster")
		throw new Error("expected a roster body");
	return l.body;
}

const BOX = SLIDE_BODY_BOX_1280;

function frame(id: string, body: RosterBody): string {
	// The slide frame is the cqw container; the body box sits inside it with the
	// deck's own padding, exactly as `ContentSlide` lays it out.
	return `<div style="container-type:inline-size;width:${BOX.clientWidth}px;margin-bottom:40px">
<div id="${id}" style="box-sizing:border-box;width:${BOX.clientWidth}px;height:${BOX.clientHeight}px;padding:${BOX.paddingTop}px ${BOX.paddingRight}px ${BOX.paddingBottom}px ${BOX.paddingLeft}px;display:flex;flex-direction:column;justify-content:center;overflow:hidden">
<div class="inner" style="width:100%">${renderToStaticMarkup(<NextMeetingBodyView body={body} />)}</div>
</div></div>`;
}

type Natural = { width: number; height: number };

function measure(ids: readonly string[], html: string): Natural[] {
	const chrome = findChrome();
	if (!chrome) throw new Error("No Chrome");
	const probe = `<script>
	document.title = ${JSON.stringify(ids)}.map(function (id) {
		var n = document.getElementById(id).querySelector(".inner");
		return [n.scrollWidth, n.scrollHeight].join(",");
	}).join("|");
	</script>`;
	const dir = mkdtempSync(join(tmpdir(), "next-meeting-fit-"));
	try {
		const path = join(dir, "page.html");
		writeFileSync(
			path,
			`<!doctype html><html><head><title>x</title><style>body{margin:0;font-family:'Manrope', ui-sans-serif, system-ui, sans-serif}</style></head><body>${html}${probe}</body></html>`,
			"utf8",
		);
		const dom = execFileSync(
			chrome,
			[
				"--headless",
				"--disable-gpu",
				"--no-sandbox",
				`--user-data-dir=${dir}`,
				"--disable-extensions",
				"--host-resolver-rules=MAP * ~NOTFOUND",
				"--window-size=1400,1600",
				"--virtual-time-budget=2000",
				"--dump-dom",
				`file://${path}`,
			],
			{ encoding: "utf8", stdio: "pipe", timeout: 10_000, env: CHROME_ENV },
		);
		const title = dom.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
		const rows = title.split("|");
		if (rows.length !== ids.length) {
			throw new Error(`The probe did not run; Chrome reported "${title}".`);
		}
		return rows.map((row) => {
			const [width, height] = row.split(",").map(Number);
			return { width: width ?? Number.NaN, height: height ?? Number.NaN };
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("next-meeting slide harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so the next-meeting slide geometry would skip and " +
				"the suite would still report green.",
		).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"the next-meeting slide fits one slide legibly (#932)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		it("at a realistic worst case, where listing every role would not", () => {
			const worst = bodyOf(WORST);
			// Not vacuous: this case really is past the row cap, so the collapsing
			// is what is being measured.
			expect(worst.filled).not.toBeNull();
			const control: RosterBody = {
				...worst,
				rows: WORST.map((r) => ({
					label: r.label,
					names: r.names.join(", ") || null,
					open: r.openCount > 0 ? "Open: grab it!" : null,
				})),
				filled: null,
			};
			const allOpen = bodyOf(
				WORST.map((r) => role(r.label, [], r.names.length + r.openCount)),
			);
			const [w, c, o] = measure(
				["worst", "control", "all-open"],
				frame("worst", worst) +
					frame("control", control) +
					frame("all-open", allOpen),
			);
			if (!w || !c || !o) throw new Error("missing measurement");
			const scale = (n: Natural) => fitScale(BOX, n);

			expect(scale(w)).toBeGreaterThanOrEqual(MIN_SCALE);
			// A next meeting nobody has signed up for yet — the common case a week
			// out — collapses the open roles too, and stays as legible.
			expect(scale(o)).toBeGreaterThanOrEqual(MIN_SCALE);
			// The control: fourteen rows would have shrunk the slide well past it.
			expect(scale(c)).toBeLessThan(MIN_SCALE);
		});

		/**
		 * The two caps, measured AT the cap and against the absolute floor — never
		 * stated in terms of the constant itself, which would loosen as the
		 * constant grows. Raising either cap past what fits turns these red; the
		 * absolute floors in `slide-layout-next-meeting.test.ts` turn lowering
		 * them red.
		 */
		it("a full row cap of long names stays above the floor", () => {
			const cap = bodyOf(WORST.slice(0, MAX_ROSTER_ROWS));
			// Tier 1 really is what is measured: every role its own row.
			expect(cap.filled).toBeNull();
			expect(cap.rows).toHaveLength(Math.min(MAX_ROSTER_ROWS, WORST.length));
			const [t] = measure(["cap"], frame("cap", cap));
			if (!t) throw new Error("missing measurement");
			expect(fitScale(BOX, t)).toBeGreaterThanOrEqual(MIN_SCALE);
		});

		it("a full open-row cap plus the filled line stays above the floor", () => {
			const roles = [
				...OPEN_POOL.slice(0, MAX_OPEN_ROWS).map((l) => role(l, [], 1)),
				...FILLED_EIGHT,
			];
			const body = bodyOf(roles);
			// Tier 2 really is what is measured: a row per open role, the filled
			// ones on one line.
			expect(body.rows).toHaveLength(Math.min(MAX_OPEN_ROWS, OPEN_POOL.length));
			expect(body.rows.every((r) => r.open)).toBe(true);
			expect(body.filled).not.toBeNull();
			expect(body.openList).toBeNull();
			const [t] = measure(["open-cap"], frame("open-cap", body));
			if (!t) throw new Error("missing measurement");
			expect(fitScale(BOX, t)).toBeGreaterThanOrEqual(MIN_SCALE);
		});

		it("an ordinary standard line-up needs no shrinking at all", () => {
			const l = slideLayout(
				{
					...slide([
						role("General Evaluator", ["Saiful"]),
						role("Table Topics Master", [], 1),
						role("Speaker", ["Rehanna", "Sudheer"], 1),
						role("Evaluator", ["Faisal"], 2),
						role("Timer", ["Chris"]),
						role("Ah-Counter", [], 1),
						role("Grammarian", ["Mona"]),
					]),
					location: "Library Room B",
					theme: "Momentum",
					meetingNumber: 57,
				},
				null,
			);
			if (l.chrome !== "content" || l.body.form !== "roster")
				throw new Error("expected a roster body");
			// Every role a row of its own — the cap is not so low that an ordinary
			// meeting's filled roles get collapsed for no reason.
			expect(l.body.rows).toHaveLength(7);
			expect(l.body.filled).toBeNull();
			const [t] = measure(["ordinary"], frame("ordinary", l.body));
			if (!t) throw new Error("missing measurement");
			expect(fitScale(BOX, t)).toBe(1);
		});
	},
);

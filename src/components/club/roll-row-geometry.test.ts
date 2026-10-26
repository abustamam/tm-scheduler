/**
 * A roll row is ONE line at a phone's width (#1309): name, role chip, status
 * trigger and the contact-menu trigger share a line, and the row is at most
 * 48px tall.
 *
 * jsdom performs no layout and loads no stylesheet, so the component tests can
 * only see that a class is present, which is the half that is not the bug: a
 * `flex-wrap` that comes back, a name that stops being the shrinkable item, a
 * status track a few px too wide each satisfy every grep and leave the row on
 * two lines. Only a browser tells them apart.
 *
 * The class strings come out of the real source files (comment-blind), so
 * stripping any one of them from the component fails this. The markup BETWEEN
 * them is synthetic: mounting the real rail needs the router, the server fns
 * and the offline queue. Pair it with `meeting-attendance-panel.test.tsx`,
 * which pins what renders.
 *
 * Scope, as the issue states it: a row with a RECORDED, non-present status.
 * A Present row also carries the in-person/online toggle (#1049) on its own
 * line, so it is taller by design and is not measured here.
 *
 * The CONTROL at the bottom is what lets the rest fail: the old two-line shape
 * rebuilt from the same classes must measure taller than 48px.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = resolve(HERE, "meeting-attendance-panel.tsx");
const NUDGE = resolve(HERE, "nudge-buttons.tsx");
const BADGE = resolve(HERE, "../ui/badge.tsx");
const BUTTON = resolve(HERE, "../ui/button.tsx");
const CARD = resolve(HERE, "../ui/card.tsx");

/** First `className="…"` after `tag`, in comment-stripped source. */
function classAfterTag(file: string, tag: string): string {
	const src = readSource(file);
	const at = src.indexOf(tag);
	expect(at, `\`${tag}\` not found in ${file}`).toBeGreaterThan(-1);
	const m = /className="([^"]*)"/.exec(src.slice(at));
	expect(m, `no className after \`${tag}\``).not.toBeNull();
	return m?.[1] ?? "";
}

/** Group 1 of the first place `re` matches in `file`, searched only AFTER
 *  `anchor` when one is given (so the search is inside the construct meant). */
function capture(
	file: string,
	re: RegExp,
	what: string,
	anchor?: string,
): string {
	const src = readSource(file);
	let from = 0;
	if (anchor) {
		from = src.indexOf(anchor);
		expect(from, `\`${anchor}\` not found in ${file}`).toBeGreaterThan(-1);
	}
	const m = re.exec(src.slice(from));
	expect(m, `${what} not found in ${file}`).not.toBeNull();
	return m?.[1] ?? "";
}

/** The base classes a ui primitive passes to `cn(...)` in `function <name>`. */
function cnBaseOf(file: string, fn: string): string {
	const src = readSource(file);
	const at = src.indexOf(`function ${fn}(`);
	expect(at, `\`function ${fn}\` not found in ${file}`).toBeGreaterThan(-1);
	const m = /cn\(\s*"([^"]*)"/.exec(src.slice(at));
	expect(m, `no cn("…") in ${fn}`).not.toBeNull();
	return m?.[1] ?? "";
}

const hasChrome = findChrome() !== null;

describe("roll-row geometry harness availability", () => {
	it("has a browser to measure with when running in CI", () => {
		// A silently absent geometry gate reads exactly like a passing one, so in
		// CI its absence is a failure rather than a skip.
		if (!process.env.CI) return;
		expect(
			hasChrome,
			"CI has no Chrome, so every geometry measurement would skip and the " +
				"suite would still report green.",
		).toBe(true);
	});
});

/** Headless Chrome lays no window out narrower than 500px, so the PAGE is
 *  pinned to a phone's 375px instead; the probe reports the real
 *  `window.innerWidth`, and the assertions use that, not this request. */
const PHONE_PX = 375;
const VIEWPORT = { width: 500, height: 800 };
/** Tailwind's `md` breakpoint: below it the status track is `w-36`. */
const MD_PX = 768;

type Shape = "oneLine" | "twoLine" | "plan";
/** The widest label a plan trigger shows (an assumed Coming), and a long role
 *  code; the real chip shows the code, not the role name. */
const PLAN_LABEL = "Coming · assumed";
const PLAN_CODE = "TOASTM";
/** The widest label a roll trigger shows. */
const ROLL_LABEL = "Excused";

const NAME = "Abdul-Rasheed Bustamam-Featherstonehaugh";

type Measure = {
	innerWidth: number;
	railWidth: number;
	/** The row's padding box: the 1px divider between rows is not part of it. */
	rowHeight: number;
	nameMid: number;
	chipMid: number;
	statusMid: number;
	menuMid: number;
	nameTruncated: boolean;
	statusWidth: number;
	/** The status trigger's content width minus its box; > 0 is a clipped label. */
	statusClip: number;
	/** The document's horizontal scroll overflow; > 0 scrolls sideways. */
	pageOverflow: number;
	/** Right-most control edge minus the row's right edge; > 0 is clipped. */
	overhang: number;
};

describe.skipIf(!hasChrome)(
	"a roll row at a phone's width (#1309)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		const cls = {
			cardBase: "",
			card: "",
			cardBodyBase: "",
			cardBody: "",
			row: "",
			mainLine: "",
			identity: "",
			name: "",
			badgeBase: "",
			badgeSecondary: "",
			chipBadge: "",
			actionLine: "",
			buttonBase: "",
			outline: "",
			ghost: "",
			sm: "",
			iconSm: "",
			status: "",
			planStatus: "",
			menuTrigger: "",
		};

		const button = (variant: string, size: string, extra: string) =>
			`${cls.buttonBase} ${variant} ${size} ${extra}`;

		/** One roll row, the shipped classes around synthetic contents. */
		function rowHtml(shape: Shape): string {
			const plan = shape === "plan";
			const chipText = plan ? PLAN_CODE : "TD";
			const identity = `<div class="${cls.identity}"><span class="${cls.name}" title="${NAME}" data-name>${NAME}</span><span data-slot="badge" class="${cls.badgeBase} ${cls.badgeSecondary} ${cls.chipBadge}" data-chip><span aria-hidden>${chipText}</span></span></div>`;
			const status = `<button type="button" class="${button(cls.outline, cls.sm, plan ? cls.planStatus : cls.status)}" data-status><span class="sr-only">${NAME} status</span><span aria-hidden>${plan ? PLAN_LABEL : ROLL_LABEL}</span><svg class="size-3.5" viewBox="0 0 24 24" width="14" height="14"></svg></button>`;
			const menu = `<button type="button" class="${button(cls.ghost, cls.iconSm, cls.menuTrigger)}" aria-label="Contact ${NAME}" data-menu><svg class="size-4" viewBox="0 0 24 24" width="16" height="16"></svg></button>`;
			const actions = `<div class="${cls.actionLine}">${status}${menu}</div>`;
			// The CONTROL: the pre-#1309 shape, the action line under the identity.
			const inner =
				shape !== "twoLine"
					? `<div class="${cls.mainLine}">${identity}${actions}</div>`
					: `<div class="flex flex-col gap-1.5">${identity}${actions}</div>`;
			// A divider-bearing row ABOVE it, as in the real list, so the measured
			// row is the second and carries no `last:` exemption surprises.
			return `<ul data-list><li class="${cls.row}">${identity.replace(/data-[a-z]+/g, "")}</li><li class="${cls.row}" data-row>${inner}</li></ul>`;
		}

		const PROBE = `<script>
		(function () {
			function fail(why) { document.title = "ERROR:" + why; }
			var q = function (s) { return document.querySelector(s); };
			var row = q("[data-row]"), nm = q("[data-name]"), chip = q("[data-chip]");
			var st = q("[data-status]"), menu = q("[data-menu]"), rail = q("[data-rail]");
			if (!row || !nm || !chip || !st || !menu || !rail) return fail("missing element");
			var r = function (el) { return el.getBoundingClientRect(); };
			var out = {
				innerWidth: window.innerWidth,
				railWidth: Math.round(r(rail).width),
				rowHeight: row.clientHeight,
				nameMid: Math.round(r(nm).top + r(nm).height / 2),
				chipMid: Math.round(r(chip).top + r(chip).height / 2),
				statusMid: Math.round(r(st).top + r(st).height / 2),
				menuMid: Math.round(r(menu).top + r(menu).height / 2),
				nameTruncated: nm.scrollWidth > nm.clientWidth ? 1 : 0,
				statusWidth: Math.round(r(st).width),
				statusClip: st.scrollWidth - st.clientWidth,
				pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				overhang: Math.round(Math.max(r(st).right, r(menu).right) - r(row).right)
			};
			document.title = Object.keys(out).map(function (k) { return k + "=" + out[k]; }).join(";");
		})();
		</script>`;

		function measure(shape: Shape): Measure {
			const bodyHtml = `<div style="width:${PHONE_PX}px" data-rail><div class="${cls.cardBase} ${cls.card}"><div class="${cls.cardBodyBase} ${cls.cardBody}">${rowHtml(shape)}</div></div></div>`;
			const title = renderAndReadTitle({
				bodyHtml,
				css,
				script: PROBE,
				viewport: VIEWPORT,
				tmpPrefix: "roll-row-",
			});
			// A missing title means the script never ran, and every field would then
			// read as "fits" — exactly the bug this measures.
			if (!title.includes("rowHeight=")) {
				throw new Error(
					`probe produced no measurement (title: ${title || "∅"})`,
				);
			}
			const kv = new Map(
				title.split(";").map((p) => p.split("=") as [string, string]),
			);
			const n = (k: string) => Number(kv.get(k) ?? "NaN");
			return {
				innerWidth: n("innerWidth"),
				railWidth: n("railWidth"),
				rowHeight: n("rowHeight"),
				nameMid: n("nameMid"),
				chipMid: n("chipMid"),
				statusMid: n("statusMid"),
				menuMid: n("menuMid"),
				nameTruncated: n("nameTruncated") === 1,
				statusWidth: n("statusWidth"),
				statusClip: n("statusClip"),
				pageOverflow: n("pageOverflow"),
				overhang: n("overhang"),
			};
		}

		beforeAll(async () => {
			cls.cardBase = cnBaseOf(CARD, "Card");
			cls.card = classAfterTag(PANEL, "<Card ");
			cls.cardBodyBase = cnBaseOf(CARD, "CardContent");
			cls.cardBody = classAfterTag(PANEL, "<CardContent");
			cls.row = classAfterTag(PANEL, "function PanelRow");
			cls.mainLine = classAfterTag(PANEL, "function PanelMainLine");
			cls.identity = classAfterTag(PANEL, "function PanelIdentityLine");
			cls.name = capture(
				PANEL,
				/IDENTITY_NAME_CLASS\s*=\s*"([^"]*)"/,
				"IDENTITY_NAME_CLASS",
			);
			cls.badgeBase = capture(BADGE, /cva\(\s*"([^"]*)"/, "badge base");
			cls.badgeSecondary = capture(
				BADGE,
				/secondary:\s*"([^"]*)"/,
				"badge secondary",
				"variants:",
			);
			// The role chip's own class on the roll row's `<Badge variant="secondary">`.
			cls.chipBadge = capture(
				PANEL,
				/<Badge variant="secondary" className="([^"]*)"/,
				"role chip className",
				"function PanelIdentityLine",
			);
			cls.actionLine = classAfterTag(PANEL, "function PanelActionLine");
			cls.buttonBase = capture(BUTTON, /cva\(\s*"([^"]*)"/, "button base");
			cls.outline = capture(
				BUTTON,
				/outline:\s*"([^"]*)"/,
				"outline",
				"variant: {",
			);
			cls.ghost = capture(BUTTON, /ghost:\s*"([^"]*)"/, "ghost", "variant: {");
			cls.sm = capture(BUTTON, /\n\s*sm:\s*"([^"]*)"/, "size sm", "size: {");
			cls.iconSm = capture(
				BUTTON,
				/"icon-sm":\s*"([^"]*)"/,
				"size icon-sm",
				"size: {",
			);
			// The RECORDED chip's trigger (RollChip), the one a recorded row shows.
			const rollChip = readSource(PANEL);
			const at = rollChip.indexOf("function RollChip");
			expect(at, "function RollChip not found").toBeGreaterThan(-1);
			const status = /className="(w-36 justify-between[^"]*)"/.exec(
				rollChip.slice(at),
			);
			expect(
				status,
				"RollChip's recorded trigger class not found",
			).not.toBeNull();
			cls.status = status?.[1] ?? "";
			// The PLAN row's trigger (AttendanceRow), `cn("w-44 …", m.assumed && …)`.
			cls.planStatus = capture(
				PANEL,
				/cn\(\s*"(w-44[^"]*)"/,
				"plan row trigger className",
				"function AttendanceRow",
			);
			cls.menuTrigger = capture(
				NUDGE,
				/size="icon-sm"\s*className="([^"]*)"/,
				"menu trigger className",
				'layout === "menu"',
			);
			css = await buildAppCss(
				candidatesIn(
					Object.values(cls)
						.concat(["flex flex-col gap-1.5", "size-3.5", "size-4", "sr-only"])
						.map((c) => `<i class="${c}"></i>`)
						.join(""),
				),
			);
		});

		it("keeps name, role chip, status trigger and contact-menu trigger on one line, at most 48px tall", () => {
			const m = measure("oneLine");
			// The page is what is pinned to 375px; the probe's own reading is what
			// proves the `md:` arm is OFF (the `w-36` track) and the rail is a phone's.
			expect(m.innerWidth, "the md: breakpoint must be off").toBeLessThan(
				MD_PX,
			);
			expect(m.railWidth).toBe(PHONE_PX);
			expect(m.statusWidth, "status track below md is w-36").toBe(144);
			// "Excused", the widest roll label (~55.7px + 42px of button chrome =
			// ~98px, measured), fits the 144px track.
			expect(
				m.statusClip,
				"the roll label overflows its track",
			).toBeLessThanOrEqual(0);
			expect(
				m.rowHeight,
				`row is ${m.rowHeight}px tall, not one line`,
			).toBeLessThanOrEqual(48);
			// Vertical CENTRES, not `top`: the row is `items-center`, so the 20px name
			// text sits 6px below the 32px buttons' top edge on one shared line.
			// Centres within 4px is "one line"; a wrapped row differs by 30px+.
			const tops = [m.nameMid, m.chipMid, m.statusMid, m.menuMid];
			expect(
				Math.max(...tops) - Math.min(...tops),
				`vertical centres (name, chip, status, menu) = ${tops.join(", ")}`,
			).toBeLessThanOrEqual(4);
			// What gives way is the name, not the controls.
			expect(m.nameTruncated, "a long name truncates").toBe(true);
			expect(m.overhang, "controls clipped by the row").toBeLessThanOrEqual(0);
		});

		it("keeps a plan row showing 'Coming · assumed' on one line at 375px, label unclipped, nothing scrolling sideways", () => {
			const m = measure("plan");
			expect(m.innerWidth, "the md: breakpoint must be off").toBeLessThan(
				MD_PX,
			);
			expect(m.statusWidth, "the plan trigger is w-44 at every width").toBe(
				176,
			);
			expect(
				m.statusClip,
				`"${PLAN_LABEL}" overflows its ${m.statusWidth}px trigger`,
			).toBeLessThanOrEqual(0);
			expect(m.rowHeight, `row is ${m.rowHeight}px tall`).toBeLessThanOrEqual(
				48,
			);
			const mids = [m.nameMid, m.chipMid, m.statusMid, m.menuMid];
			expect(
				Math.max(...mids) - Math.min(...mids),
				`vertical centres (name, chip, status, menu) = ${mids.join(", ")}`,
			).toBeLessThanOrEqual(4);
			expect(m.nameTruncated, "the long name is what gives way").toBe(true);
			expect(m.overhang, "controls clipped by the row").toBeLessThanOrEqual(0);
			expect(m.pageOverflow, "page scrolls sideways").toBeLessThanOrEqual(0);
		});

		it("CONTROL: the pre-#1309 two-line shape fails the same measurement", () => {
			const m = measure("twoLine");
			expect(m.rowHeight).toBeGreaterThan(48);
			const tops = [m.nameMid, m.statusMid];
			expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(4);
		});
	},
);

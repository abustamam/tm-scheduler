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
 * The CONTROLS at the bottom are what let the rest fail: the old two-line shape
 * rebuilt from the same classes must measure taller than 48px, and the
 * viewport-keyed track (`md:`, no container, 24px of card padding) must leave
 * the real rail's identity box under its floor.
 *
 * The RAIL cases run the route's real `<aside>` classes at the two viewports
 * that fix its width (1024px: `lg:w-[340px]`; 1440px: `xl:w-96`), because the
 * bug was that the status track followed the VIEWPORT while the rail is
 * narrower than a phone.
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
const ROUTE = resolve(HERE, "../../routes/club.$clubId.meeting.$meetingId.tsx");

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
/** Tailwind's `md` breakpoint. The status track no longer follows it (it is a
 *  container query on the list now), so the phone cases still assert the
 *  viewport is below it only to prove they measure a phone. */
const MD_PX = 768;
/** The two viewports that fix the rail's width: `lg` (1024px) makes the aside
 *  340px, `xl` (1280px, tested at 1440) makes it 384px. */
const LG_VIEWPORT = { width: 1024, height: 800 };
const XL_VIEWPORT = { width: 1440, height: 800 };
const LG_RAIL_PX = 340;
const XL_RAIL_PX = 384;
/** A stacked tablet panel: `md` is on, `lg` is off, so the card is the page's
 *  width, and its list is wide enough for the `@md` (28rem) container query. */
const TABLET_VIEWPORT = { width: 800, height: 800 };
const TABLET_PANEL_PX = 720;
/** `@md` is `min-width: 28rem`. */
const CONTAINER_MD_PX = 448;
/** Card border (1px a side) plus `px-6` (24px a side): list width = card - 50. */
const CARD_CHROME_PX = 50;

type Shape = "oneLine" | "twoLine" | "plan";
/** The widest label a plan trigger shows (an assumed Coming), and a long role
 *  code; the real chip shows the code, not the role name. */
const PLAN_STATUS = "Coming";
const PLAN_QUALIFIER = " · assumed";
const PLAN_LABEL = `${PLAN_STATUS}${PLAN_QUALIFIER}`;
const ASKED_QUALIFIER = " · asked";
type Qualifier = "assumed" | "asked";
const PLAN_CODE = "TOASTM";
/** The widest label a roll trigger shows. */
const ROLL_LABEL = "Excused";

const NAME = "Abdul-Rasheed Bustamam-Featherstonehaugh";

type Measure = {
	innerWidth: number;
	railWidth: number;
	/** The `<ul>` every row's width (and the `@md:` track) is measured against. */
	listWidth: number;
	/** The identity box (name + role chip): what the controls leave of the row. */
	identityWidth: number;
	/** Left padding of the card's header and body, which must agree. */
	headerInset: number;
	bodyInset: number;
	/** The row's padding box: the 1px divider between rows is not part of it. */
	rowHeight: number;
	nameMid: number;
	chipMid: number;
	statusMid: number;
	menuMid: number;
	nameTruncated: boolean;
	/** The name's box width: what is left for it after the controls. */
	nameWidth: number;
	/** The status label's visible text (`innerText`: a `display:none` span is absent). */
	labelText: string;
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
			aside: "",
			cardBase: "",
			card: "",
			cardHeaderBase: "",
			cardHeader: "",
			cardBodyBase: "",
			cardBody: "",
			list: "",
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
			qualifier: "",
			qualifierAsked: "",
			menuTrigger: "",
		};

		type Classes = typeof cls;
		/** The classes as they were before the track followed the panel's width. */
		let preFix: Classes;

		/** Where the rail sits: a div pinned to a width (a phone, a stacked
		 *  tablet panel), or the route's real `<aside>`, whose width the
		 *  VIEWPORT decides through its `lg:` / `xl:` classes. */
		type Rail = { px: number } | "aside";

		const button = (c: Classes, variant: string, size: string, extra: string) =>
			`${c.buttonBase} ${variant} ${size} ${extra}`;

		/** One roll row, the shipped classes around synthetic contents. */
		function rowHtml(
			shape: Shape,
			word: Qualifier = "assumed",
			c: Classes = cls,
		): string {
			const plan = shape === "plan";
			const chipText = plan ? PLAN_CODE : "TD";
			const identity = `<div class="${c.identity}" data-identity><span class="${c.name}" title="${NAME}" data-name>${NAME}</span><span data-slot="badge" class="${c.badgeBase} ${c.badgeSecondary} ${c.chipBadge}" data-chip><span aria-hidden>${chipText}</span></span></div>`;
			const status = `<button type="button" class="${button(c, c.outline, c.sm, plan ? c.planStatus : c.status)}" data-status><span class="sr-only">${NAME} status</span><span aria-hidden data-label>${plan ? `${PLAN_STATUS}<span class="${word === "assumed" ? c.qualifier : c.qualifierAsked}">${word === "assumed" ? PLAN_QUALIFIER : ASKED_QUALIFIER}</span>` : ROLL_LABEL}</span><svg class="size-3.5" viewBox="0 0 24 24" width="14" height="14"></svg></button>`;
			const menu = `<button type="button" class="${button(c, c.ghost, c.iconSm, c.menuTrigger)}" aria-label="Contact ${NAME}" data-menu><svg class="size-4" viewBox="0 0 24 24" width="16" height="16"></svg></button>`;
			const actions = `<div class="${c.actionLine}">${status}${menu}</div>`;
			// The CONTROL: the pre-#1309 shape, the action line under the identity.
			const inner =
				shape !== "twoLine"
					? `<div class="${c.mainLine}">${identity}${actions}</div>`
					: `<div class="flex flex-col gap-1.5">${identity}${actions}</div>`;
			// A divider-bearing row ABOVE it, as in the real list, so the measured
			// row is the second and carries no `last:` exemption surprises. The list
			// carries the panel's own `@container` class: the status track's `@md:`
			// arm is measured against it.
			return `<ul class="${c.list}" data-list><li class="${c.row}">${identity.replace(/data-[a-z]+/g, "")}</li><li class="${c.row}" data-row>${inner}</li></ul>`;
		}

		const PROBE = `<script>
		(function () {
			function fail(why) { document.title = "ERROR:" + why; }
			var q = function (s) { return document.querySelector(s); };
			var row = q("[data-row]"), nm = q("[data-name]"), chip = q("[data-chip]");
			var st = q("[data-status]"), menu = q("[data-menu]"), rail = q("[data-rail]");
			var ident = q("[data-identity]"), list = q("[data-list]");
			var header = q("[data-header]"), body = q("[data-body]");
			if (!row || !nm || !chip || !st || !menu || !rail || !ident || !list || !header || !body) return fail("missing element");
			var r = function (el) { return el.getBoundingClientRect(); };
			var out = {
				innerWidth: window.innerWidth,
				railWidth: Math.round(r(rail).width),
				listWidth: Math.round(r(list).width),
				identityWidth: Math.round(r(ident).width),
				headerInset: parseFloat(getComputedStyle(header).paddingLeft),
				bodyInset: parseFloat(getComputedStyle(body).paddingLeft),
				rowHeight: row.clientHeight,
				nameMid: Math.round(r(nm).top + r(nm).height / 2),
				chipMid: Math.round(r(chip).top + r(chip).height / 2),
				statusMid: Math.round(r(st).top + r(st).height / 2),
				menuMid: Math.round(r(menu).top + r(menu).height / 2),
				nameTruncated: nm.scrollWidth > nm.clientWidth ? 1 : 0,
				nameWidth: Math.round(r(nm).width),
				labelText: q("[data-label]").innerText,
				statusWidth: Math.round(r(st).width),
				statusClip: st.scrollWidth - st.clientWidth,
				pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				overhang: Math.round(Math.max(r(st).right, r(menu).right) - r(row).right)
			};
			document.title = Object.keys(out).map(function (k) { return k + "=" + out[k]; }).join(";");
		})();
		</script>`;

		function measure(
			shape: Shape,
			opts: {
				viewport?: { width: number; height: number };
				word?: Qualifier;
				rail?: Rail;
				c?: Classes;
			} = {},
		): Measure {
			const {
				viewport = VIEWPORT,
				word = "assumed",
				rail = { px: PHONE_PX },
			} = opts;
			const c = opts.c ?? cls;
			const railOpen =
				rail === "aside"
					? `<aside class="${c.aside}" data-rail>`
					: `<div style="width:${rail.px}px" data-rail>`;
			const railClose = rail === "aside" ? "</aside>" : "</div>";
			const bodyHtml = `${railOpen}<div class="${c.cardBase} ${c.card}"><div class="${c.cardHeaderBase} ${c.cardHeader}" data-header>Planned attendance</div><div class="${c.cardBodyBase} ${c.cardBody}" data-body>${rowHtml(shape, word, c)}</div></div>${railClose}`;
			const title = renderAndReadTitle({
				bodyHtml,
				css,
				script: PROBE,
				viewport,
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
				listWidth: n("listWidth"),
				identityWidth: n("identityWidth"),
				headerInset: n("headerInset"),
				bodyInset: n("bodyInset"),
				rowHeight: n("rowHeight"),
				nameMid: n("nameMid"),
				chipMid: n("chipMid"),
				statusMid: n("statusMid"),
				menuMid: n("menuMid"),
				nameTruncated: n("nameTruncated") === 1,
				nameWidth: n("nameWidth"),
				labelText: kv.get("labelText") ?? "",
				statusWidth: n("statusWidth"),
				statusClip: n("statusClip"),
				pageOverflow: n("pageOverflow"),
				overhang: n("overhang"),
			};
		}

		beforeAll(async () => {
			cls.aside = classAfterTag(ROUTE, "<aside");
			cls.cardBase = cnBaseOf(CARD, "Card");
			cls.card = classAfterTag(PANEL, "<Card ");
			cls.cardHeaderBase = cnBaseOf(CARD, "CardHeader");
			cls.cardHeader = classAfterTag(PANEL, "<CardHeader");
			cls.cardBodyBase = cnBaseOf(CARD, "CardContent");
			cls.cardBody = classAfterTag(PANEL, "<CardContent");
			cls.list = classAfterTag(PANEL, '<ul role="list"');
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
			// The PLAN row's trigger (AttendanceRow), `cn("w-36 … @md:w-44", m.assumed && …)`.
			cls.planStatus = capture(
				PANEL,
				/cn\(\s*"(w-36[^"]*)"/,
				"plan row trigger className",
				"function AttendanceRow",
			);
			// The qualifier span inside the aria-hidden visible label: ONE ternary,
			// `qualifier === ASSUMED_WORD ? <assumed arm> : <asked arm>`. Both arms are
			// read, so putting `hidden @md:inline` on the asked arm changes this test.
			cls.qualifier = capture(
				PANEL,
				/qualifier === ASSUMED_WORD\s*\?\s*"([^"]*)"/,
				"plan row qualifier className (assumed arm)",
				"function AttendanceRow",
			);
			// `undefined` (no class) is the only arm that keeps "asked" visible.
			const askedArm = capture(
				PANEL,
				/qualifier === ASSUMED_WORD\s*\?\s*"[^"]*"\s*:\s*(undefined|"[^"]*")/,
				"plan row qualifier className (asked arm)",
				"function AttendanceRow",
			);
			cls.qualifierAsked =
				askedArm === "undefined" ? "" : askedArm.replace(/"/g, "");
			cls.menuTrigger = capture(
				NUDGE,
				/size="icon-sm"\s*className="([^"]*)"/,
				"menu trigger className",
				'layout === "menu"',
			);
			// The pre-fix shape, for the CONTROLS: every class this change moved,
			// put back. `swap` fails when the shipped class is not there to swap, so
			// a control cannot quietly measure the shipped markup twice.
			const swap = (value: string, from: string, to: string) => {
				const was = value.replace(/\s+/g, " ").trim();
				const out = was.replace(from, to).replace(/\s+/g, " ").trim();
				expect(out, `\`${from}\` is not in "${was}"`).not.toBe(was);
				return out;
			};
			preFix = {
				...cls,
				aside: swap(cls.aside, " xl:w-96", ""),
				cardHeader: swap(cls.cardHeader, "lg:px-4", ""),
				cardBody: swap(cls.cardBody, "lg:px-4", ""),
				list: swap(cls.list, "@container", ""),
				status: swap(cls.status, "@md:w-44", "md:w-44"),
				planStatus: swap(cls.planStatus, "@md:w-44", "md:w-44"),
				qualifier: swap(cls.qualifier, "@md:inline", "md:inline"),
			};
			css = await buildAppCss(
				candidatesIn(
					[...Object.values(cls), ...Object.values(preFix)]
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

		it("keeps a plan row on one line at 375px: bare 'Coming' unclipped in the 144px trigger, the name given the room, nothing scrolling sideways", () => {
			const m = measure("plan");
			expect(m.innerWidth, "the md: breakpoint must be off").toBeLessThan(
				MD_PX,
			);
			expect(m.statusWidth, "the plan trigger is w-36 below md").toBe(144);
			// The qualifier is `display:none` below md: the label is the bare status.
			expect(m.labelText, "visible label below md").toBe(PLAN_STATUS);
			expect(
				m.statusClip,
				`"${PLAN_STATUS}" overflows its ${m.statusWidth}px trigger`,
			).toBeLessThanOrEqual(0);
			// What the name keeps: with a 6-char role chip it still gets a real box.
			// Font-dependent, so the floor sits between the two tracks rather than on
			// one font's number: at `w-36` the name measured 56px (macOS sans) and
			// 49px (CI, DejaVu, whose chip is wider); at the old `w-44` it was 24px /
			// ~17px. 40 fails the old track in both and passes the new one in both.
			expect(m.nameWidth, "the name's box").toBeGreaterThanOrEqual(40);
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

		it("keeps 'Coming · asked' VISIBLE at 375px on one line, overflowing the 144px trigger by at most 8px (the harness font is the system sans, not Manrope: DejaVu overflows ~6px, Manrope fits)", () => {
			const m = measure("plan", { word: "asked" });
			expect(m.innerWidth, "the md: breakpoint must be off").toBeLessThan(
				MD_PX,
			);
			expect(m.statusWidth).toBe(144);
			expect(m.labelText, "visible label below md").toBe(
				`${PLAN_STATUS}${ASKED_QUALIFIER}`,
			);
			expect(m.statusClip, "clip beyond the ~6px fallback").toBeLessThanOrEqual(
				8,
			);
			expect(m.rowHeight, `row is ${m.rowHeight}px tall`).toBeLessThanOrEqual(
				48,
			);
			expect(m.pageOverflow, "page scrolls sideways").toBeLessThanOrEqual(0);
		});

		it("shows 'Coming · assumed' unclipped in the 176px trigger once the LIST is 28rem wide (a stacked 720px tablet panel)", () => {
			const m = measure("plan", {
				viewport: TABLET_VIEWPORT,
				rail: { px: TABLET_PANEL_PX },
			});
			expect(m.listWidth, "the list the container query reads").toBe(
				TABLET_PANEL_PX - CARD_CHROME_PX,
			);
			expect(m.listWidth).toBeGreaterThanOrEqual(CONTAINER_MD_PX);
			expect(m.statusWidth, "the plan trigger is @md:w-44").toBe(176);
			expect(m.labelText, "visible label from 28rem").toBe(PLAN_LABEL);
			expect(
				m.statusClip,
				`"${PLAN_LABEL}" overflows its ${m.statusWidth}px trigger`,
			).toBeLessThanOrEqual(0);
			expect(m.rowHeight, `row is ${m.rowHeight}px tall`).toBeLessThanOrEqual(
				48,
			);
		});

		it("switches the track at exactly 28rem of LIST width: 447px keeps the 144px track, 448px takes 176px", () => {
			const under = measure("plan", {
				rail: { px: CONTAINER_MD_PX - 1 + CARD_CHROME_PX },
			});
			expect(under.listWidth).toBe(CONTAINER_MD_PX - 1);
			expect(under.statusWidth).toBe(144);
			expect(under.labelText).toBe(PLAN_STATUS);
			const at = measure("plan", {
				rail: { px: CONTAINER_MD_PX + CARD_CHROME_PX },
			});
			expect(at.listWidth).toBe(CONTAINER_MD_PX);
			expect(at.statusWidth).toBe(176);
			expect(at.labelText).toBe(PLAN_LABEL);
		});

		/**
		 * The bug, at the widths it lived at. The rail is the route's real
		 * `<aside>`: 340px at `lg` (1024px) and 384px at `xl` (1440px), narrower
		 * than a phone, and the status track used to follow the VIEWPORT, so both
		 * got the widest (176px) track and left a role holder's name ~18px.
		 *
		 * `identityWidth` is what the fixed controls leave of the row, so it does
		 * not depend on the font: list (rail - 2px border - 2 x 16px padding) - 8px
		 * gap - the 144px track - 12px gap - the 32px menu. The floors sit a few px
		 * under what that measures. `nameWidth` is the font-dependent half and
		 * keeps the looser margin the 375px case uses.
		 */
		for (const [where, viewport, railPx, identityFloor] of [
			["the 340px lg rail", LG_VIEWPORT, LG_RAIL_PX, 104],
			["the 384px xl rail", XL_VIEWPORT, XL_RAIL_PX, 148],
		] as const) {
			it(`${where}: the track stays 144px, the identity box keeps >= ${identityFloor}px, one line, header and rows share one 16px inset`, () => {
				for (const shape of ["oneLine", "plan"] as const) {
					const m = measure(shape, { viewport, rail: "aside" });
					const at = `${where}, ${shape}`;
					expect(m.railWidth, `${at}: the aside's width`).toBe(railPx);
					expect(m.listWidth, `${at}: the list's width`).toBe(railPx - 34);
					expect(m.headerInset, `${at}: header padding`).toBe(16);
					expect(m.bodyInset, `${at}: body padding`).toBe(16);
					expect(
						m.statusWidth,
						`${at}: the viewport must not widen the track`,
					).toBe(144);
					expect(
						m.identityWidth,
						`${at}: identity is ${m.identityWidth}px`,
					).toBeGreaterThanOrEqual(identityFloor);
					expect(
						m.rowHeight,
						`${at}: row is ${m.rowHeight}px tall`,
					).toBeLessThanOrEqual(48);
					const mids = [m.nameMid, m.chipMid, m.statusMid, m.menuMid];
					expect(
						Math.max(...mids) - Math.min(...mids),
						`${at}: vertical centres (name, chip, status, menu) = ${mids.join(", ")}`,
					).toBeLessThanOrEqual(4);
					expect(
						m.statusClip,
						`${at}: status label clipped`,
					).toBeLessThanOrEqual(0);
					expect(
						m.overhang,
						`${at}: controls clipped by the row`,
					).toBeLessThanOrEqual(0);
					expect(
						m.pageOverflow,
						`${at}: page scrolls sideways`,
					).toBeLessThanOrEqual(0);
					if (shape === "plan") {
						expect(m.labelText, `${at}: assumed is hidden under 28rem`).toBe(
							PLAN_STATUS,
						);
						// A 6-character role code is the widest chip a real row wears; the
						// name still gets a box (macOS sans ~37px at lg, DejaVu narrower).
						expect(
							m.nameWidth,
							`${at}: the name's box beside a ${PLAN_CODE} chip`,
						).toBeGreaterThanOrEqual(24);
					}
				}
			});
		}

		it("the identity box on phones is font-independent too: a 375px card leaves it 129px, a real 375px page (16px gutters, a 343px card) 97px", () => {
			// Not changed by the rail fix (phones keep the 144px track and 24px of
			// card padding); pinned so a later change to either cannot quietly take
			// the name's room, which is what the 176px track did to the rail.
			const card = measure("oneLine");
			expect(
				card.identityWidth,
				`identity is ${card.identityWidth}px`,
			).toBeGreaterThanOrEqual(120);
			const page = measure("plan", { rail: { px: PHONE_PX - 32 } });
			expect(page.railWidth).toBe(PHONE_PX - 32);
			expect(page.statusWidth).toBe(144);
			expect(
				page.identityWidth,
				`identity is ${page.identityWidth}px`,
			).toBeGreaterThanOrEqual(92);
			expect(page.rowHeight).toBeLessThanOrEqual(48);
			expect(page.pageOverflow).toBeLessThanOrEqual(0);
		});

		it("CONTROL: the pre-fix classes (viewport-keyed track, 24px card padding, no container) leave the real rail's identity box under the floor", () => {
			for (const [viewport, railPx] of [
				[LG_VIEWPORT, LG_RAIL_PX],
				[XL_VIEWPORT, LG_RAIL_PX],
			] as const) {
				const m = measure("plan", { viewport, rail: "aside", c: preFix });
				// The old rail is 340px at BOTH viewports (no `xl:w-96`), and its track
				// followed the viewport: 176px, the widest, in a rail narrower than a phone.
				expect(m.railWidth).toBe(railPx);
				expect(m.statusWidth, "the old track followed the viewport").toBe(176);
				expect(m.labelText, "and showed the assumed suffix").toBe(PLAN_LABEL);
				expect(
					m.identityWidth,
					`identity is ${m.identityWidth}px`,
				).toBeLessThan(104);
			}
		});

		it("CONTROL: the pre-#1309 two-line shape fails the same measurement", () => {
			const m = measure("twoLine");
			expect(m.rowHeight).toBeGreaterThan(48);
			const tops = [m.nameMid, m.statusMid];
			expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(4);
		});
	},
);

/**
 * A roll row's geometry at the widths the meeting page really gives it.
 *
 * ONE LINE (#1309) wherever the panel sits beside its controls: name, role
 * chip, status trigger and contact-menu trigger share a line and the row is at
 * most 48px tall. That is the 340px `lg` rail, the 384px `xl` rail and a
 * full-width tablet panel. ON A PHONE (#1420) the status line drops UNDER the
 * identity (name and role chip), so the name gets the row instead of the ~57px
 * (beside "TD") or ~24px (beside "TOASTM") the controls left it.
 *
 * jsdom performs no layout and loads no stylesheet, so the component tests can
 * only see that a class is present, which is the half that is not the bug: a
 * `flex-wrap` that comes back, a name that stops being the shrinkable item, a
 * status track a few px too wide, a restack condition that reaches the rail,
 * each satisfy every grep. Only a browser tells them apart.
 *
 * The class strings come out of the real source files (comment-blind), so
 * stripping any one of them from the component fails this. The wrappers are the
 * REAL page's: the route's `containerClass` gutter, its `flex flex-col gap-5
 * lg:flex-row` column wrapper and its `<aside>`, read from the route file. The
 * markup BETWEEN the panel's classes and the contents of a row are synthetic:
 * mounting the real panel needs the router, the server fns and the offline
 * queue. Pair it with `meeting-attendance-panel.test.tsx`, which pins what
 * renders.
 *
 * "375px" is a 375px-wide box around those wrappers, not a window: headless
 * Chrome lays no window out narrower than 500px. The window stays below every
 * breakpoint the page uses at a phone (`sm` 640, `lg` 1024), so each media
 * query answers as it would on a 375px phone.
 *
 * Scope, as the issue states it: a row with a RECORDED, non-present status.
 * A Present row also carries the in-person/online toggle (#1049) on its own
 * line, so it is taller by design and is not measured here.
 *
 * The CONTROLS are what let the rest fail: the old two-line shape rebuilt from
 * the same classes must measure taller than 48px, the viewport-keyed track
 * (`md:`, no container, 24px of card padding) must leave the real rail's
 * identity box under its floor, and the phone page WITHOUT the restack must
 * leave the name its old ~57px / ~24px.
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

/** A phone's width. The page sits in a box this wide inside a 500px window
 *  (see the header); the probe reports the real `window.innerWidth`. */
const PHONE_PX = 375;
const VIEWPORT = { width: 500, height: 800 };
/** The route's gutter below `sm` (`px-4`): the panel is the page less this. */
const PHONE_GUTTER_PX = 32;
/** `sm:px-7` (28px a side) applies from 640px, so at the 800px tablet window. */
const TABLET_GUTTER_PX = 56;
/** Tailwind's `md` breakpoint; the phone cases assert the window is below it. */
const MD_PX = 768;
/** The two viewports that fix the rail's width: `lg` (1024px) makes the aside
 *  340px, `xl` (1280px, tested at 1440) makes it 384px. */
const LG_VIEWPORT = { width: 1024, height: 800 };
const XL_VIEWPORT = { width: 1440, height: 800 };
const LG_RAIL_PX = 340;
const XL_RAIL_PX = 384;
/** A full-width tablet panel: `md` is on, `lg` is off, so the panel is the page
 *  less the gutters, and its list is wide enough for the `@md` (28rem) query. */
const TABLET_VIEWPORT = { width: 800, height: 800 };
/** `@md` is `min-width: 28rem`. */
const CONTAINER_MD_PX = 448;
/** Card border (1px a side) plus `px-6` (24px a side) below `lg`. */
const CARD_CHROME_PX = 50;
/** At `lg` the card's body is `lg:px-4`: border plus 16px a side. */
const CARD_CHROME_LG_PX = 34;

type Shape = "roll" | "twoLine" | "plan";
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
/** A short name: one word, so it fits one line even in the narrowest name box
 *  the single-line cases produce (24px, beside the widest role chip in a 340px
 *  rail). The one-line height cases use it; a two-word name wraps in that rail
 *  box, by design (#1420). */
const NAME = "Al";
/** A short TWO-word name (#1420 AC3): one line on a phone, beside any chip. */
const TWO_WORD_NAME = "Ann Lee";
/** About 14 characters (#1420): too wide for the box a role code leaves beside
 *  the controls, so it must be shown whole once the controls drop under it. */
const MID_NAME = "Demo Presenter";
/** Too long for two lines anywhere, with a word wider than the box too. */
const LONG_NAME =
	"Abdul-Rasheed Bustamam-Featherstonehaugh Cholmondeley-Wellington";

type Measure = {
	innerWidth: number;
	/** The `<aside>` the panel sits in. */
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
	/** The status trigger starts below the identity: the phone restack. */
	stacked: boolean;
	/** Rendered lines of the name: its box height over its line height. */
	nameLines: number;
	/** The name has content hidden below its box (the clamp's ellipsis). */
	nameClippedV: boolean;
	/** The name has content hidden past its right edge. */
	nameClippedH: boolean;
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

const CLASS_KEYS = [
	"pageBox",
	"columns",
	"leftColumn",
	"aside",
	"cardBase",
	"card",
	"cardHeaderBase",
	"cardHeader",
	"cardBodyBase",
	"cardBody",
	"list",
	"row",
	"mainLine",
	"identity",
	"name",
	"linkName",
	"badgeBase",
	"badgeSecondary",
	"chipBadge",
	"actionLine",
	"buttonBase",
	"outline",
	"ghost",
	"sm",
	"iconSm",
	"status",
	"planStatus",
	"assumedMuted",
	"qualifier",
	"qualifierAsked",
	"menuTrigger",
] as const;
type Classes = Record<(typeof CLASS_KEYS)[number], string>;

type RowOptions = {
	shape: Shape;
	word?: Qualifier;
	c?: Classes;
	name?: string;
	tag?: "span" | "a";
	/** The role chip's text; `null` is a row with no role code. */
	code?: string | null;
};

type MeasureOptions = Omit<RowOptions, "shape"> & {
	viewport?: { width: number; height: number };
	/** The page's width: the real wrappers sit in a box this wide. Omitted, the
	 *  page is the window itself (the `lg` / `xl` / tablet cases). */
	pagePx?: number;
	theme?: "light" | "dark";
};

/** Light and dark each paint the row from its own tokens (`styles.css`). */
const THEMES = ["light", "dark"] as const;

describe.skipIf(!hasChrome)(
	"a roll row at the widths the meeting page gives it (#1309, #1420)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		const cls = Object.fromEntries(CLASS_KEYS.map((k) => [k, ""])) as Classes;
		/** The classes as they were before the track followed the panel's width. */
		let preFix: Classes;
		/** The phone page without the restack: the controls stay beside the name. */
		let unstacked: Classes;

		const button = (c: Classes, variant: string, size: string, extra: string) =>
			`${c.buttonBase} ${variant} ${size} ${extra}`;

		/** One row, the shipped classes around synthetic contents. */
		function rowHtml(o: RowOptions): string {
			const {
				shape,
				word = "assumed",
				c = cls,
				name = NAME,
				tag = "span",
				code,
			} = o;
			const plan = shape === "plan";
			const chipText = code === undefined ? (plan ? PLAN_CODE : "TD") : code;
			const nameClass = tag === "a" ? `${c.name} ${c.linkName}` : c.name;
			const chip =
				chipText === null
					? ""
					: `<span data-slot="badge" class="${c.badgeBase} ${c.badgeSecondary} ${c.chipBadge}" data-chip><span aria-hidden>${chipText}</span></span>`;
			const identity = `<div class="${c.identity}" data-identity><${tag} class="${nameClass}" title="${name}" data-name${tag === "a" ? ' href="#"' : ""}>${name}</${tag}>${chip}</div>`;
			const status = `<button type="button" class="${button(c, c.outline, c.sm, plan ? c.planStatus : c.status)}" data-status><span class="sr-only">${name} status</span><span aria-hidden data-label>${plan ? `${PLAN_STATUS}<span class="${word === "assumed" ? c.qualifier : c.qualifierAsked}">${word === "assumed" ? PLAN_QUALIFIER : ASKED_QUALIFIER}</span>` : ROLL_LABEL}</span><svg class="size-3.5" viewBox="0 0 24 24" width="14" height="14"></svg></button>`;
			const menu = `<button type="button" class="${button(c, c.ghost, c.iconSm, c.menuTrigger)}" aria-label="Contact ${name}" data-menu><svg class="size-4" viewBox="0 0 24 24" width="16" height="16"></svg></button>`;
			const actions = `<div class="${c.actionLine}">${status}${menu}</div>`;
			// The CONTROL: the pre-#1309 shape, the action line under the identity.
			const inner =
				shape !== "twoLine"
					? `<div class="${c.mainLine}">${identity}${actions}</div>`
					: `<div class="flex flex-col gap-1.5">${identity}${actions}</div>`;
			// A divider-bearing row ABOVE it, as in the real list, so the measured
			// row is the second and carries no `last:` exemption surprises. The list
			// carries the panel's own `@container` class: the status track's `@md:`
			// arm and the phone restack are measured against it.
			return `<ul class="${c.list}" data-list><li class="${c.row}">${identity.replace(/ data-[a-z]+/g, "")}</li><li class="${c.row}" data-row>${inner}</li></ul>`;
		}

		/** The meeting page's wrappers around the panel's card, every class read
		 *  from the route: container gutter, column wrapper, `<aside>`. */
		function pageHtml(o: MeasureOptions & RowOptions): string {
			const c = o.c ?? cls;
			const card = `<div class="${c.cardBase} ${c.card}"><div class="${c.cardHeaderBase} ${c.cardHeader}" data-header>Planned attendance</div><div class="${c.cardBodyBase} ${c.cardBody}" data-body>${rowHtml(o)}</div></div>`;
			const page = `<div class="${c.pageBox}"><div class="${c.columns}"><div class="${c.leftColumn}"></div><aside class="${c.aside}" data-rail>${card}</aside></div></div>`;
			const boxed =
				o.pagePx === undefined
					? page
					: `<div style="width:${o.pagePx}px" data-page>${page}</div>`;
			// `.dark` carries the dark tokens and `dark:` variants; the page's own
			// `bg-background text-foreground` is what `body` would paint.
			return `<div class="bg-background text-foreground" data-theme="${o.theme ?? "light"}">${boxed}</div>`;
		}

		const PROBE = `<script>
		(function () {
			function fail(why) { document.title = "ERROR:" + why; }
			var q = function (s) { return document.querySelector(s); };
			var row = q("[data-row]"), nm = q("[data-name]"), chip = q("[data-chip]");
			var st = q("[data-status]"), menu = q("[data-menu]"), rail = q("[data-rail]");
			var ident = q("[data-identity]"), list = q("[data-list]");
			var header = q("[data-header]"), body = q("[data-body]");
			if (!row || !nm || !st || !menu || !rail || !ident || !list || !header || !body) return fail("missing element");
			var r = function (el) { return el.getBoundingClientRect(); };
			var mid = function (el) { return Math.round(r(el).top + r(el).height / 2); };
			var out = {
				innerWidth: window.innerWidth,
				railWidth: Math.round(r(rail).width),
				listWidth: Math.round(r(list).width),
				identityWidth: Math.round(r(ident).width),
				headerInset: parseFloat(getComputedStyle(header).paddingLeft),
				bodyInset: parseFloat(getComputedStyle(body).paddingLeft),
				rowHeight: row.clientHeight,
				nameMid: mid(nm),
				chipMid: mid(chip || nm),
				statusMid: mid(st),
				menuMid: mid(menu),
				stacked: r(st).top >= r(ident).bottom - 1 ? 1 : 0,
				nameLines: Math.round(r(nm).height / parseFloat(getComputedStyle(nm).lineHeight)),
				nameClippedV: nm.scrollHeight > nm.clientHeight ? 1 : 0,
				nameClippedH: nm.scrollWidth > nm.clientWidth ? 1 : 0,
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

		/** WCAG contrast of the row's text against what it is painted on, in the
		 *  theme the wrapper carries. Colours go through a canvas so whatever CSS
		 *  colour syntax the tokens use (oklch, color-mix) is read as sRGB. */
		const PAINT_PROBE = `<script>
		(function () {
			var q = function (s) { return document.querySelector(s); };
			// The app puts \`dark\` on <html>, where the :root tokens are redeclared and
			// re-resolved; a wrapper div would keep the light-resolved ones. The
			// \`a\` and \`button\` colour transitions would otherwise be read mid-flight.
			var noMotion = document.createElement("style");
			noMotion.textContent = "*,*::before,*::after{transition:none!important}";
			document.head.appendChild(noMotion);
			var themed = q("[data-theme]").getAttribute("data-theme") === "dark";
			if (themed) document.documentElement.classList.add("dark");
			var cv = document.createElement("canvas");
			cv.width = 1; cv.height = 1;
			var cx = cv.getContext("2d", { willReadFrequently: true });
			function rgba(c) {
				cx.clearRect(0, 0, 1, 1);
				cx.fillStyle = "#000";
				cx.fillStyle = c;
				cx.fillRect(0, 0, 1, 1);
				var d = cx.getImageData(0, 0, 1, 1).data;
				return [d[0], d[1], d[2], d[3] / 255];
			}
			function over(top, under) {
				var a = top[3];
				return [0, 1, 2].map(function (k) { return top[k] * a + under[k] * (1 - a); });
			}
			function bgOf(el) {
				var layers = [];
				for (var e = el; e; e = e.parentElement) {
					var c = rgba(getComputedStyle(e).backgroundColor);
					layers.push(c);
					if (c[3] >= 1) break;
				}
				var base = layers[layers.length - 1];
				var out = base[3] >= 1 ? base.slice(0, 3) : [255, 255, 255];
				for (var i = layers.length - (base[3] >= 1 ? 2 : 1); i >= 0; i--) out = over(layers[i], out);
				return out;
			}
			function lum(c) {
				var f = c.map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
				return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
			}
			function contrast(el) {
				var bg = bgOf(el);
				var fg = over(rgba(getComputedStyle(el).color), bg);
				var a = lum(fg), b = lum(bg);
				return ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
			}
			var nm = q("[data-name]"), label = q("[data-label]"), chip = q("[data-chip] span");
			var out = {
				dark: document.documentElement.classList.contains("dark") ? 1 : 0,
				nameContrast: contrast(nm),
				labelContrast: contrast(label),
				chipContrast: contrast(chip),
				nameClipped: nm.scrollHeight > nm.clientHeight || nm.scrollWidth > nm.clientWidth ? 1 : 0,
				pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
			};
			document.title = Object.keys(out).map(function (k) { return k + "=" + out[k]; }).join(";");
		})();
		</script>`;

		function read(
			bodyHtml: string,
			viewport: { width: number; height: number },
			script: string,
			marker: string,
		): Map<string, string> {
			const title = renderAndReadTitle({
				bodyHtml,
				css,
				script,
				viewport,
				tmpPrefix: "roll-row-",
			});
			// A missing title means the script never ran, and every field would then
			// read as "fits" — exactly the bug this measures.
			if (!title.includes(marker)) {
				throw new Error(
					`probe produced no measurement (title: ${title || "∅"})`,
				);
			}
			return new Map(
				title.split(";").map((p) => p.split("=") as [string, string]),
			);
		}

		function measure(shape: Shape, opts: MeasureOptions = {}): Measure {
			const kv = read(
				pageHtml({ shape, ...opts }),
				opts.viewport ?? VIEWPORT,
				PROBE,
				"rowHeight=",
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
				stacked: n("stacked") === 1,
				nameLines: n("nameLines"),
				nameClippedV: n("nameClippedV") === 1,
				nameClippedH: n("nameClippedH") === 1,
				nameWidth: n("nameWidth"),
				labelText: kv.get("labelText") ?? "",
				statusWidth: n("statusWidth"),
				statusClip: n("statusClip"),
				pageOverflow: n("pageOverflow"),
				overhang: n("overhang"),
			};
		}

		/** The phone page, 375px, in the given theme: the real row, painted. */
		function paint(
			shape: Shape,
			theme: "light" | "dark",
			opts: MeasureOptions,
		) {
			const kv = read(
				pageHtml({ shape, theme, pagePx: PHONE_PX, ...opts }),
				VIEWPORT,
				PAINT_PROBE,
				"nameContrast=",
			);
			const n = (k: string) => Number(kv.get(k) ?? "NaN");
			return {
				dark: n("dark") === 1,
				nameContrast: n("nameContrast"),
				labelContrast: n("labelContrast"),
				chipContrast: n("chipContrast"),
				nameClipped: n("nameClipped") === 1,
				pageOverflow: n("pageOverflow"),
			};
		}

		beforeAll(async () => {
			// The route's own wrappers: gutter, column wrapper, left column, aside.
			cls.pageBox = capture(
				ROUTE,
				/const containerClass = canManage\s*\?\s*"([^"]*)"/,
				"containerClass (the manager arm)",
			);
			cls.columns = capture(
				ROUTE,
				/className="(flex flex-col gap-5 lg:flex-row[^"]*)"/,
				"the column wrapper className",
			);
			cls.leftColumn = capture(
				ROUTE,
				/className="(order-2 min-w-0 flex-1[^"]*)"/,
				"the left column className",
				"flex flex-col gap-5 lg:flex-row",
			);
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
				/const IDENTITY_NAME_CLASS\s*=\s*"([^"]*)"/,
				"IDENTITY_NAME_CLASS",
			);
			// The linked name's extra classes, `cn(IDENTITY_NAME_CLASS, "…")`.
			cls.linkName = capture(
				PANEL,
				/cn\(IDENTITY_NAME_CLASS,\s*"([^"]*)"\)/,
				"the linked name's extra classes",
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
			// The muted ink an ASSUMED plan row's trigger adds.
			cls.assumedMuted = capture(
				PANEL,
				/m\.assumed &&\s*"([^"]*)"/,
				"the assumed row's muted class",
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
			// `swap`/`drop` fail when the shipped class is not there to change, so a
			// control cannot quietly measure the shipped markup twice.
			const swap = (value: string, from: string, to: string) => {
				const was = value.replace(/\s+/g, " ").trim();
				const out = was.replace(from, to).replace(/\s+/g, " ").trim();
				expect(out, `\`${from}\` is not in "${was}"`).not.toBe(was);
				return out;
			};
			const drop = (value: string, re: RegExp) => {
				const was = value.replace(/\s+/g, " ").trim();
				const out = was.replace(re, "").replace(/\s+/g, " ").trim();
				expect(out, `${re} is not in "${was}"`).not.toBe(was);
				return out;
			};
			// The pre-fix shape, for the CONTROLS: every class the rail fix moved,
			// put back.
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
			// The phone page as #1420's clamp alone left it: no restack.
			unstacked = {
				...cls,
				mainLine: drop(cls.mainLine, /\bmax-lg:@max-md:\S+/g),
				actionLine: drop(cls.actionLine, /\bmax-lg:@max-md:\S+/g),
			};
			css = await buildAppCss(
				candidatesIn(
					[
						...Object.values(cls),
						...Object.values(preFix),
						...Object.values(unstacked),
					]
						.concat([
							"flex flex-col gap-1.5",
							"size-3.5",
							"size-4",
							"sr-only",
							"dark bg-background text-foreground",
						])
						.map((c) => `<i class="${c}"></i>`)
						.join(""),
				),
			);
		});

		/** Vertical centres within 4px is "one line"; a wrapped row differs by 30px+. */
		const centresSpread = (m: Measure) => {
			const mids = [m.nameMid, m.chipMid, m.statusMid, m.menuMid];
			return Math.max(...mids) - Math.min(...mids);
		};

		/**
		 * THE PHONE (#1420): the real page at 375px, a 343px panel and a 293px
		 * list. The status line is under the identity, the name has the row, and
		 * the 144px track and the contact menu are untouched. Both row shapes
		 * (plan and recorded) share `PanelIdentityLine` and `PanelMainLine`, so both
		 * run every case.
		 */
		describe("the phone page (375px, a 343px panel)", () => {
			const PANEL_PX = PHONE_PX - PHONE_GUTTER_PX;
			const LIST_PX = PANEL_PX - CARD_CHROME_PX;
			const phone = (shape: Shape, o: MeasureOptions = {}) =>
				measure(shape, { pagePx: PHONE_PX, ...o });

			for (const shape of ["plan", "roll"] as const) {
				it(`${shape}: the real wrappers give a ${PANEL_PX}px panel and a ${LIST_PX}px list, with the md: breakpoint off`, () => {
					const m = phone(shape);
					expect(m.innerWidth, "the md: breakpoint must be off").toBeLessThan(
						MD_PX,
					);
					expect(m.railWidth, "the <aside>, at the route's gutter").toBe(
						PANEL_PX,
					);
					expect(m.listWidth).toBe(LIST_PX);
				});

				it(`${shape}: the status line sits UNDER the identity, the 144px track holds, the contact menu stays in the row`, () => {
					const m = phone(shape);
					expect(m.stacked, "the status line did not drop").toBe(true);
					expect(m.statusWidth, "the status track is not narrowed").toBe(144);
					expect(
						m.statusClip,
						"the status label overflows its track",
					).toBeLessThanOrEqual(0);
					expect(
						m.identityWidth,
						"the identity owns the whole list width",
					).toBe(LIST_PX);
					expect(m.statusMid, "the menu shares the status line").toBe(
						m.menuMid,
					);
					expect(m.overhang, "controls clipped by the row").toBeLessThanOrEqual(
						0,
					);
					expect(m.pageOverflow, "page scrolls sideways").toBeLessThanOrEqual(
						0,
					);
					// A role code never takes the name's second line: the chip is beside it.
					expect(
						Math.abs(m.nameMid - m.chipMid),
						"the chip is on the name's line",
					).toBeLessThanOrEqual(4);
				});

				// AC1 and AC3, on the real page. TD and TOASTM are the short and the
				// widest codes; the unrestacked box was ~57px and ~24px.
				for (const code of ["TD", PLAN_CODE, null] as const) {
					it(`${shape}, ${code ?? "no role code"}: a ~14-character name shows WHOLE and a short two-word name sits on ONE line (#1420 AC1, AC3)`, () => {
						for (const tag of ["span", "a"] as const) {
							const mid = phone(shape, { name: MID_NAME, tag, code });
							const at = `${tag}, "${MID_NAME}"`;
							expect(mid.stacked, at).toBe(true);
							expect(mid.nameLines, `${at}: ${mid.nameLines} lines`).toBe(1);
							expect(mid.nameClippedV, `${at}: no ellipsis`).toBe(false);
							expect(mid.nameClippedH, `${at}: clipped sideways`).toBe(false);
							const two = phone(shape, { name: TWO_WORD_NAME, tag, code });
							const at2 = `${tag}, "${TWO_WORD_NAME}"`;
							expect(two.nameLines, `${at2}: ${two.nameLines} lines`).toBe(1);
							expect(two.nameClippedV, at2).toBe(false);
						}
					});
				}

				for (const tag of ["span", "a"] as const) {
					it(`${shape}, <${tag}>: a name too long for two lines clamps at EXACTLY two with an ellipsis, a long word breaks, controls stay inside (#1420)`, () => {
						const m = phone(shape, { name: LONG_NAME, tag, code: PLAN_CODE });
						expect(m.stacked).toBe(true);
						expect(m.nameLines, `name is on ${m.nameLines} lines`).toBe(2);
						expect(m.nameClippedV, "no ellipsis: nothing was cut").toBe(true);
						expect(m.nameClippedH, "a long word is clipped sideways").toBe(
							false,
						);
						expect(m.statusWidth, "the status track is not narrowed").toBe(144);
						expect(
							m.overhang,
							"controls clipped by the row",
						).toBeLessThanOrEqual(0);
						expect(m.pageOverflow, "page scrolls sideways").toBeLessThanOrEqual(
							0,
						);
						// Two 20px lines, the 8px gap, the 32px controls and the row's
						// padding; a third line would add 20px.
						expect(
							m.rowHeight,
							`row is ${m.rowHeight}px tall`,
						).toBeLessThanOrEqual(96);
					});
				}
			}

			it("the name box is nearly the whole row: a short name keeps >= 230px beside TD and >= 200px beside TOASTM", () => {
				// Name box = list less the chip and the 6px gap; font-dependent, so the
				// floors sit well under what Manrope and the fallback measure.
				for (const [code, floor] of [
					["TD", 230],
					[PLAN_CODE, 200],
				] as const) {
					const m = phone("plan", { name: LONG_NAME, code });
					expect(
						m.nameWidth,
						`${code}: name box is ${m.nameWidth}px`,
					).toBeGreaterThanOrEqual(floor);
				}
			});

			it("the linked <a> and the plain <span> measure the same for a mid and a long name", () => {
				for (const name of [MID_NAME, LONG_NAME]) {
					const span = phone("plan", { code: "TD", name });
					const link = phone("plan", { code: "TD", name, tag: "a" });
					expect(link.nameLines, name).toBe(span.nameLines);
					expect(link.rowHeight, name).toBe(span.rowHeight);
					expect(link.nameClippedV, name).toBe(span.nameClippedV);
				}
			});

			it("plan: bare 'Coming' is unclipped in the 144px trigger; 'Coming · asked' stays VISIBLE and overflows it by at most 8px (the harness font is the system sans: DejaVu overflows ~6px, Manrope fits)", () => {
				const bare = phone("plan");
				expect(bare.labelText, "visible label under 28rem").toBe(PLAN_STATUS);
				expect(bare.statusClip).toBeLessThanOrEqual(0);
				const asked = phone("plan", { word: "asked" });
				expect(asked.labelText).toBe(`${PLAN_STATUS}${ASKED_QUALIFIER}`);
				expect(asked.statusWidth).toBe(144);
				expect(
					asked.statusClip,
					"clip beyond the ~6px fallback",
				).toBeLessThanOrEqual(8);
				expect(asked.pageOverflow).toBeLessThanOrEqual(0);
			});

			it("CONTROL: the same page WITHOUT the restack leaves the name its old sliver: a TD chip ~57px, TOASTM ~24px, and a 14-character name does not fit on a line", () => {
				const td = phone("plan", { c: unstacked, code: "TD", name: LONG_NAME });
				expect(td.stacked).toBe(false);
				expect(td.nameWidth, `TD name box ${td.nameWidth}px`).toBeLessThan(80);
				const toastm = phone("plan", {
					c: unstacked,
					code: PLAN_CODE,
					name: LONG_NAME,
				});
				expect(
					toastm.nameWidth,
					`TOASTM name box ${toastm.nameWidth}px`,
				).toBeLessThan(40);
				const mid = phone("plan", { c: unstacked, code: "TD", name: MID_NAME });
				expect(mid.nameLines, "the clamp alone cannot keep it on a line").toBe(
					2,
				);
				const two = phone("plan", {
					c: unstacked,
					code: PLAN_CODE,
					name: TWO_WORD_NAME,
				});
				expect(two.nameLines, "a short name wrapped: AC3's regression").toBe(2);
			});
		});

		/**
		 * THE RESTACK'S BOUNDARY, on both axes. A phone's list is under 28rem
		 * (stacked); a window narrower than `lg` whose list is 28rem or more (a
		 * tablet panel) is not; the 340px `lg` rail, whose list is narrower than
		 * the phone's, is not either (the rail cases below).
		 */
		describe("where the restack applies", () => {
			const pageFor = (list: number) => list + CARD_CHROME_PX + PHONE_GUTTER_PX;
			for (const shape of ["plan", "roll"] as const) {
				it(`${shape}: 447px of LIST under lg is stacked on the 144px track, 448px is one line on the 176px track`, () => {
					const under = measure(shape, {
						pagePx: pageFor(CONTAINER_MD_PX - 1),
					});
					expect(under.listWidth).toBe(CONTAINER_MD_PX - 1);
					expect(under.stacked, "447px: stacked").toBe(true);
					expect(under.statusWidth).toBe(144);
					const at = measure(shape, { pagePx: pageFor(CONTAINER_MD_PX) });
					expect(at.listWidth).toBe(CONTAINER_MD_PX);
					expect(at.stacked, "448px: one line").toBe(false);
					expect(at.statusWidth).toBe(176);
					expect(at.rowHeight).toBeLessThanOrEqual(48);
				});

				it(`${shape}: a full-width tablet panel (800px window, below lg) stays ONE line on the 176px track`, () => {
					const m = measure(shape, { viewport: TABLET_VIEWPORT });
					const list =
						TABLET_VIEWPORT.width - TABLET_GUTTER_PX - CARD_CHROME_PX;
					expect(m.listWidth, "the list the container query reads").toBe(list);
					expect(m.listWidth).toBeGreaterThanOrEqual(CONTAINER_MD_PX);
					expect(m.stacked, "a tablet panel is not restacked").toBe(false);
					expect(m.statusWidth, "the track is @md:w-44").toBe(176);
					expect(
						m.statusClip,
						"the status label overflows its track",
					).toBeLessThanOrEqual(0);
					expect(
						m.rowHeight,
						`row is ${m.rowHeight}px tall`,
					).toBeLessThanOrEqual(48);
					expect(centresSpread(m)).toBeLessThanOrEqual(4);
					if (shape === "plan") {
						expect(m.labelText, "visible label from 28rem").toBe(PLAN_LABEL);
					}
				});
			}
		});

		/**
		 * The rails, at the widths the bug in #1309 lived at: the route's real
		 * `<aside>`, 340px at `lg` (1024px) and 384px at `xl` (1440px), narrower
		 * than a phone's list is wide. `lg` is ON here, so the phone restack must
		 * NOT reach them: the viewport half of its condition is what holds that,
		 * since the rail's 306px list is under 28rem too.
		 *
		 * `identityWidth` is what the fixed controls leave of the row, so it does
		 * not depend on the font: list (rail - 2px border - 2 x 16px padding) - 8px
		 * gap - the 144px track - 12px gap - the 32px menu. The floors sit a few px
		 * under what that measures.
		 */
		for (const [where, viewport, railPx, identityFloor] of [
			["the 340px lg rail", LG_VIEWPORT, LG_RAIL_PX, 104],
			["the 384px xl rail", XL_VIEWPORT, XL_RAIL_PX, 148],
		] as const) {
			describe(where, () => {
				for (const shape of ["roll", "plan"] as const) {
					it(`${shape}: the track stays 144px, the row stays ONE line (not restacked), the identity box keeps >= ${identityFloor}px, header and rows share one 16px inset`, () => {
						const m = measure(shape, { viewport });
						const at = `${where}, ${shape}`;
						expect(m.railWidth, `${at}: the aside's width`).toBe(railPx);
						expect(m.listWidth, `${at}: the list's width`).toBe(
							railPx - CARD_CHROME_LG_PX,
						);
						expect(m.headerInset, `${at}: header padding`).toBe(16);
						expect(m.bodyInset, `${at}: body padding`).toBe(16);
						expect(m.stacked, `${at}: the phone restack reached the rail`).toBe(
							false,
						);
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
						expect(
							centresSpread(m),
							`${at}: vertical centres (name, chip, status, menu)`,
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
						}
					});

					// What #1309 and #1351 protected: a name with every kind of pressure
					// (a 6-character role code, 64 characters with a word wider than the
					// box) never pushes a control out of the row or narrows the track.
					for (const tag of ["span", "a"] as const) {
						it(`${shape}, <${tag}>: a LONG name beside a ${PLAN_CODE} chip clamps at two lines; the controls stay inside the row and the 144px track holds`, () => {
							const m = measure(shape, {
								viewport,
								name: LONG_NAME,
								tag,
								code: PLAN_CODE,
							});
							const at = `${where}, ${shape}, ${tag}`;
							expect(m.stacked, `${at}: restacked`).toBe(false);
							expect(m.statusWidth, `${at}: track`).toBe(144);
							expect(
								m.nameLines,
								`${at}: ${m.nameLines} lines`,
							).toBeLessThanOrEqual(2);
							expect(m.nameClippedH, `${at}: a long word spills`).toBe(false);
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
							// Two 20px lines against the 32px controls: the row grows by a
							// name's second line at most, never a third.
							expect(
								m.rowHeight,
								`${at}: row is ${m.rowHeight}px tall`,
							).toBeLessThanOrEqual(64);
							expect(
								m.nameWidth,
								`${at}: the name's box beside ${PLAN_CODE}`,
							).toBeGreaterThanOrEqual(20);
						});
					}
				}
			});
		}

		it("CONTROL: the pre-fix classes (viewport-keyed track, 24px card padding, no container) leave the real rail's identity box under the floor", () => {
			for (const [viewport, railPx] of [
				[LG_VIEWPORT, LG_RAIL_PX],
				[XL_VIEWPORT, LG_RAIL_PX],
			] as const) {
				const m = measure("plan", { viewport, c: preFix });
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

		it("CONTROL: the pre-#1309 two-line shape fails the one-line measurement", () => {
			const m = measure("twoLine", { viewport: LG_VIEWPORT });
			expect(m.rowHeight).toBeGreaterThan(48);
			const tops = [m.nameMid, m.statusMid];
			expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(4);
		});

		/**
		 * #1420 AC6: light and dark at 375px. The real row is painted by the real
		 * stylesheet under each theme (`.dark` carries the dark tokens), and every
		 * line of text on it must clear AA (4.5:1, all of it is under 18px) with
		 * the name unclipped. The status label is measured plain and, on the plan
		 * row, in the muted ink an ASSUMED row adds.
		 */
		describe("light and dark at 375px", () => {
			for (const theme of THEMES) {
				for (const shape of ["plan", "roll"] as const) {
					for (const tag of ["span", "a"] as const) {
						it(`${theme}, ${shape}, <${tag}>: name, status label and role chip clear 4.5:1, a 14-character name is whole, a long one clamps, nothing scrolls sideways`, () => {
							const p = paint(shape, theme, {
								name: LONG_NAME,
								tag,
								code: PLAN_CODE,
							});
							expect(p.dark, "the theme was not applied").toBe(
								theme === "dark",
							);
							expect(p.nameContrast, `${theme} name`).toBeGreaterThanOrEqual(
								4.5,
							);
							expect(
								p.labelContrast,
								`${theme} status label`,
							).toBeGreaterThanOrEqual(4.5);
							expect(
								p.chipContrast,
								`${theme} role chip`,
							).toBeGreaterThanOrEqual(4.5);
							expect(
								p.nameClipped,
								"the clamp's ellipsis is the only cut",
							).toBe(true);
							expect(p.pageOverflow).toBeLessThanOrEqual(0);
							const whole = paint(shape, theme, {
								name: MID_NAME,
								tag,
								code: "TD",
							});
							expect(whole.nameClipped, "a 14-character name is whole").toBe(
								false,
							);
						});
					}
				}

				it(`${theme}: an ASSUMED plan row's muted status ink still clears 4.5:1`, () => {
					const p = paint("plan", theme, {
						c: { ...cls, planStatus: `${cls.planStatus} ${cls.assumedMuted}` },
					});
					expect(
						p.labelContrast,
						`${theme} muted label`,
					).toBeGreaterThanOrEqual(4.5);
				});
			}
		});
	},
);

// The browser suite above reads TWO of the panel's three status tracks out of
// source (the recorded chip and the plan trigger). The third is the unrecorded
// suggestion pair's wrapper, a `div` the harness does not measure, and a
// mutation check found `@md:w-44` -> `md:w-44` on it survives every measurement:
// that row's track would follow the VIEWPORT again (176px in a 340px rail) while
// the other two follow the panel. This needs no browser, so it also runs where
// the suite above skips.
describe("every status track in the attendance panel follows the panel, not the viewport", () => {
	const tracks = readSource(PANEL).match(/"[^"\n]*\bw-36\b[^"\n]*"/g) ?? [];

	it("finds the three tracks (the recorded chip, the plan trigger, the suggestion pair)", () => {
		expect(tracks.length).toBeGreaterThanOrEqual(3);
	});

	it("each w-36 track widens at `@md:` of the list, never at the viewport's `md:`", () => {
		for (const track of tracks) {
			expect(track, `${track} widens at the viewport, not the panel`).toMatch(
				/(^|[\s"])@md:w-44(\s|")/,
			);
			expect(track).not.toMatch(/(^|[\s"])md:w-44/);
		}
	});
});

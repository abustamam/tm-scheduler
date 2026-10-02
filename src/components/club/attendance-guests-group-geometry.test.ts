/**
 * A guest's badge in the roll-mode Guests group stays inside the attendance
 * rail, and what gives way is the caption (#1080 review).
 *
 * The badge is `w-fit shrink-0 whitespace-nowrap` (`badge.tsx`), one
 * unwrappable item of a `flex-wrap` row, and #1080 put a caption built from a
 * home club of up to `GUEST_TEXT_MAX` (120) characters inside it beside the
 * name, the in-person/online toggle and the remove control. Capping the
 * CAPTION span bounded the wrong box: the badge still grew to its content and
 * pushed past the rail whole — 436px in the 290px desktop rail, 111px over on
 * a phone — and the card body grew a sideways scrollbar.
 *
 * jsdom performs no layout and loads no stylesheet, so the component test
 * beside this one reports the same (zero) geometry whichever class is present,
 * and a source grep can see that `max-w-full` or `truncate` is THERE, which is
 * exactly the half that is not the bug: a ceiling on the wrong element, a
 * `truncate` whose item cannot shrink, a `shrink` that squeezes the name in
 * proportion — each satisfies every grep and only a browser tells them apart.
 *
 * The class strings come out of the real source files, so stripping any one of
 * them from the component fails this. The markup BETWEEN them is synthetic:
 * mounting the real group needs the shared `GuestEditDialog` and its server
 * fns. So this proves the class COMBINATION lays out inside the rail; pair it
 * with `attendance-guests-group-caption.test.tsx`, which pins what renders.
 *
 * The CONTROLS at the bottom are what make the rest able to fail: the shipped
 * markup with one class removed at a time, each reproducing a measured bug.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { GUEST_TEXT_MAX } from "#/lib/guest-profile";
import { readSource } from "#/test/guard-source";
import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const HERE = dirname(fileURLToPath(import.meta.url));
const GROUP = resolve(HERE, "attendance-guests-group.tsx");
const TOGGLE = resolve(HERE, "attendance-mode-toggle.tsx");
const PANEL = resolve(HERE, "meeting-attendance-panel.tsx");
const BADGE = resolve(HERE, "../ui/badge.tsx");
const CARD = resolve(HERE, "../ui/card.tsx");
const MEETING_ROUTE = resolve(
	HERE,
	"../../routes/club.$clubId.meeting.$meetingId.tsx",
);

/**
 * All four readers are comment-blind (`readSource` strips comments): every
 * element here carries a long comment that quotes its own class names, and
 * matching one would measure documentation rather than the shipped attribute.
 */

/** First `className="…"` after an opening tag. */
function classAfterTag(file: string, tag: string): string {
	const src = readSource(file);
	const at = src.indexOf(tag);
	expect(at, `\`${tag}\` not found in ${file}`).toBeGreaterThan(-1);
	const m = /className="([^"]*)"/.exec(src.slice(at));
	expect(m, `no className after \`${tag}\``).not.toBeNull();
	return m?.[1] ?? "";
}

/** The unique `className="…"` CONTAINING `fragment`. Uniqueness is asserted,
 *  because a fragment that started matching two elements would silently
 *  measure whichever came first. */
function classContaining(file: string, fragment: string): string {
	const hits = [...readSource(file).matchAll(/className="([^"]*)"/g)]
		.map((m) => m[1] as string)
		.filter((c) => c.includes(fragment));
	expect(
		hits,
		`\`${fragment}\` should match exactly one className in ${file}`,
	).toHaveLength(1);
	return hits[0] as string;
}

/** The `className="…"` at the one place `re` matches — for the two name spans
 *  that both read `truncate` and differ only in what surrounds them. The
 *  pattern's whitespace is `\s*`, so Biome's line-breaking of the tag cannot
 *  move the match. `re` captures the class string in group 1. */
function classMatching(file: string, re: RegExp): string {
	const hits = [...readSource(file).matchAll(re)].map((m) => m[1] as string);
	expect(
		hits,
		`\`${re.source}\` should match exactly once in ${file}`,
	).toHaveLength(1);
	return hits[0] as string;
}

/** The first string literal containing `fragment` (the `cn(…)` case). */
function classLiteralContaining(file: string, fragment: string): string {
	const hits = [...readSource(file).matchAll(/"([^"\n]*)"/g)]
		.map((m) => m[1] as string)
		.filter((c) => c.includes(fragment));
	expect(hits.length, `\`${fragment}\` not found in ${file}`).toBeGreaterThan(
		0,
	);
	return hits[0] as string;
}

/** The base classes a ui primitive passes to `cn(...)` in `function <name>`.
 *  `CardContent`'s `px-6` is the rail's horizontal padding, and the panel's
 *  own className on it carries none, so reading only that would model a rail
 *  48px wider than the one officers get. */
function cnBaseOf(file: string, fn: string): string {
	const src = readSource(file);
	const at = src.indexOf(`function ${fn}(`);
	expect(at, `\`function ${fn}\` not found in ${file}`).toBeGreaterThan(-1);
	const m = /cn\(\s*"([^"]*)"/.exec(src.slice(at));
	expect(m, `no cn("…") in ${fn}`).not.toBeNull();
	return m?.[1] ?? "";
}

const hasChrome = findChrome() !== null;

describe("guests-group geometry harness availability", () => {
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

/** A home club at its cap, so the caption is as wide as one can be. */
const HOME_CLUB = "Downtown Toastmasters International Club "
	.repeat(4)
	.slice(0, GUEST_TEXT_MAX);
const CAPTION = `Guest speaker, ${HOME_CLUB}`;
/** A caption that fits beside everything, even on the rail. */
const SHORT_CAPTION = "Visiting Toastmaster";
const NAME = "Nadia Farouk";
/** A name that does not fit the rail beside the toggle on its own. */
const LONG_NAME = "Alexandria Konstantinopoulos-Vanderbilt";

/** Desktop: `lg:` applies, so the route's real `<aside>` is 340px wide. */
const VIEWPORT = { width: 1280, height: 800 };

type Measure = {
	groupClientWidth: number;
	groupScrollWidth: number;
	bodyClientWidth: number;
	bodyScrollWidth: number;
	badgeWidth: number;
	/** Badge right edge minus the row's right edge; > 0 is the bug. */
	badgeOverhang: number;
	badgeScrollWidth: number;
	badgeClientWidth: number;
	/** The visible name's text box: scroll > client means truncated. */
	nameScrollWidth: number;
	nameClientWidth: number;
	/** Visible name's right edge minus the toggle's left edge; > 0 overlaps. */
	nameOverToggle: number;
	captionWidth: number;
	captionScrollWidth: number;
	/** Right edge minus the badge's right edge; > 0 is clipped. */
	toggleOverhang: number;
	removeOverhang: number;
	documentOverflowsX: boolean;
};

describe.skipIf(!hasChrome)(
	"a guest's badge inside the attendance rail (#1080)",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		let css = "";
		const cls = {
			rail: "",
			cardBase: "",
			card: "",
			cardBodyBase: "",
			cardBody: "",
			group: "",
			badgeBase: "",
			badgeSecondary: "",
			badge: "",
			caption: "",
			namePlain: "",
			nameButton: "",
			nameButtonText: "",
			remove: "",
			toggle: "",
			segment: "",
			segmentOff: "",
		};

		type Classes = {
			badge: string;
			caption: string;
			namePlain: string;
			nameButton: string;
			nameButtonText: string;
		};
		const shipped = (): Classes => ({
			badge: cls.badge,
			caption: cls.caption,
			namePlain: cls.namePlain,
			nameButton: cls.nameButton,
			nameButtonText: cls.nameButtonText,
		});

		/** `classes` with one token removed — the mutation controls below. */
		function strip(classes: string, token: string): string {
			const out = classes
				.replace(
					new RegExp(
						`(^|\\s)${token.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&")}(?=\\s|$)`,
					),
					" ",
				)
				.replace(/\s+/g, " ")
				.trim();
			expect(out, `\`${token}\` was not in "${classes}"`).not.toBe(classes);
			return out;
		}

		function badge(
			c: Classes,
			opts: {
				name: string;
				caption: string | null;
				toggle: boolean;
				remove: boolean;
				nameAsControl: boolean;
			},
		): string {
			// The two renderings of the name: plain text for a viewer without the
			// edit capability, the #727 control (sr-only name + aria-hidden visible
			// name) for an officer. `data-name-text` is the box the name's
			// truncation is measured on in both.
			const name = opts.nameAsControl
				? `<button type="button" class="${c.nameButton}"><span class="sr-only">Edit ${opts.name}'s details</span><span aria-hidden class="${c.nameButtonText}" data-name-text>${opts.name}</span></button>`
				: `<span class="${c.namePlain}" title="${opts.name}" data-name-text>${opts.name}</span>`;
			const caption = opts.caption
				? `<span class="${c.caption}" title="${opts.caption}" data-caption><span aria-hidden>· </span>${opts.caption}</span>`
				: "";
			// The group passes `className="bg-background"` to the toggle; neither
			// segment is pressed (a `fromRole` guest's mode is null until set).
			const toggle = opts.toggle
				? `<fieldset class="${cls.toggle} bg-background" data-toggle><legend class="sr-only">How ${opts.name} attended</legend><button type="button" class="${cls.segment} ${cls.segmentOff}"><span class="sr-only">${opts.name} attended in person</span><span aria-hidden>In person</span></button><button type="button" class="${cls.segment} ${cls.segmentOff}"><span class="sr-only">${opts.name} attended online</span><span aria-hidden>Online</span></button></fieldset>`
				: "";
			const remove = opts.remove
				? `<button type="button" class="${cls.remove}" aria-label="Remove ${opts.name}" data-remove><svg class="size-3" viewBox="0 0 24 24" width="12" height="12"></svg></button>`
				: "";
			return `<span data-slot="badge" class="${cls.badgeBase} ${cls.badgeSecondary} ${c.badge}" data-badge>${name}${caption}${toggle}${remove}</span>`;
		}

		/** The panel's card around the group, as the real tree nests them. */
		function panelAround(inner: string): string {
			return `<div class="${cls.cardBase} ${cls.card}"><div class="${cls.cardBodyBase} ${cls.cardBody}" data-body><section class="space-y-2"><h3 class="font-semibold text-sm">Guests</h3><div class="${cls.group}" data-group>${inner}</div></section></div></div>`;
		}

		/** The meeting page's pinned rail: the route's real `<aside>`. */
		const desktopFixture = (inner: string) =>
			`<div class="flex gap-4"><main class="min-w-0 flex-1">main</main><aside class="${cls.rail}">${panelAround(inner)}</aside></div>`;
		/** Below `lg:` the panel is as wide as the page. Headless Chrome lays no
		 *  window out narrower than 500px, so the page is pinned instead; the
		 *  `lg:` classes on the card body still apply and change no width. */
		const atWidth = (px: number) => (inner: string) =>
			`<div style="width:${px}px">${panelAround(inner)}</div>`;
		const phoneFixture = atWidth(375);
		const tabletFixture = atWidth(768);

		const PROBE = `<script>
		(function () {
			function fail(why) { document.title = "ERROR:" + why; }
			var q = function (s) { return document.querySelector(s); };
			var body = q("[data-body]"), group = q("[data-group]"), badge = q("[data-badge]");
			if (!body) return fail("no body");
			if (!group) return fail("no group");
			if (!badge) return fail("no badge");
			var nameText = q("[data-name-text]");
			if (!nameText) return fail("no name");
			var caption = q("[data-caption]"), toggle = q("[data-toggle]"), remove = q("[data-remove]");
			var r = function (el) { return el.getBoundingClientRect(); };
			var gr = r(group), br = r(badge), nr = r(nameText);
			var doc = document.documentElement;
			var out = {
				groupClientWidth: group.clientWidth,
				groupScrollWidth: group.scrollWidth,
				bodyClientWidth: body.clientWidth,
				bodyScrollWidth: body.scrollWidth,
				badgeWidth: Math.round(br.width),
				badgeOverhang: Math.round(br.right - gr.right),
				badgeScrollWidth: badge.scrollWidth,
				badgeClientWidth: badge.clientWidth,
				nameScrollWidth: nameText.scrollWidth,
				nameClientWidth: nameText.clientWidth,
				nameOverToggle: toggle ? Math.round(nr.right - r(toggle).left) : -9999,
				captionWidth: caption ? Math.round(r(caption).width) : -1,
				captionScrollWidth: caption ? caption.scrollWidth : -1,
				toggleOverhang: toggle ? Math.round(r(toggle).right - br.right) : -9999,
				removeOverhang: remove ? Math.round(r(remove).right - br.right) : -9999,
				documentOverflowsX: doc.scrollWidth > doc.clientWidth ? 1 : 0
			};
			document.title = Object.keys(out).map(function (k) { return k + "=" + out[k]; }).join(";");
		})();
		</script>`;

		function measure(bodyHtml: string): Measure {
			const title = renderAndReadTitle({
				bodyHtml,
				css,
				script: PROBE,
				viewport: VIEWPORT,
				tmpPrefix: "guests-badge-",
			});
			// A missing title means the script never ran — every field would then
			// read as "fits", which is exactly the bug this measures.
			if (!title.includes("badgeWidth=")) {
				throw new Error(
					`probe produced no measurement (title: ${title || "∅"})`,
				);
			}
			const kv = new Map(
				title.split(";").map((p) => p.split("=") as [string, string]),
			);
			const n = (k: string) => Number(kv.get(k) ?? "NaN");
			return {
				groupClientWidth: n("groupClientWidth"),
				groupScrollWidth: n("groupScrollWidth"),
				bodyClientWidth: n("bodyClientWidth"),
				bodyScrollWidth: n("bodyScrollWidth"),
				badgeWidth: n("badgeWidth"),
				badgeOverhang: n("badgeOverhang"),
				badgeScrollWidth: n("badgeScrollWidth"),
				badgeClientWidth: n("badgeClientWidth"),
				nameScrollWidth: n("nameScrollWidth"),
				nameClientWidth: n("nameClientWidth"),
				nameOverToggle: n("nameOverToggle"),
				captionWidth: n("captionWidth"),
				captionScrollWidth: n("captionScrollWidth"),
				toggleOverhang: n("toggleOverhang"),
				removeOverhang: n("removeOverhang"),
				documentOverflowsX: kv.get("documentOverflowsX") === "1",
			};
		}

		/** The officer's view of a guest speaker with a home club at the cap:
		 *  every control present. The case the review was about. */
		const officerView = (c: Classes, nameAsControl: boolean, name = NAME) =>
			badge(c, {
				name,
				caption: CAPTION,
				toggle: true,
				remove: true,
				nameAsControl,
			});

		/** Everything the rail owes the reader, whatever is inside the badge. */
		function expectInsideTheRail(m: Measure, label: string) {
			expect(
				m.badgeOverhang,
				`${label}: badge ${m.badgeWidth}px overhangs a ${m.groupClientWidth}px row by ${m.badgeOverhang}px`,
			).toBeLessThanOrEqual(0);
			expect(m.groupScrollWidth, `${label}: the row scrolls sideways`).toBe(
				m.groupClientWidth,
			);
			expect(
				m.bodyScrollWidth,
				`${label}: the card body scrolls sideways`,
			).toBe(m.bodyClientWidth);
			expect(m.documentOverflowsX, `${label}: the page scrolls sideways`).toBe(
				false,
			);
			// Nothing inside the badge is clipped by its `overflow-hidden`: the
			// toggle and the remove control end inside the badge's own box.
			expect(
				m.badgeScrollWidth,
				`${label}: ${m.badgeScrollWidth}px of content in a ${m.badgeClientWidth}px badge`,
			).toBeLessThanOrEqual(m.badgeClientWidth);
			expect(m.toggleOverhang, `${label}: toggle clipped`).toBeLessThanOrEqual(
				0,
			);
			expect(
				m.removeOverhang,
				`${label}: remove control clipped`,
			).toBeLessThanOrEqual(0);
			expect(
				m.nameOverToggle,
				`${label}: name paints under the toggle`,
			).toBeLessThanOrEqual(0);
		}

		beforeAll(async () => {
			cls.rail = classAfterTag(MEETING_ROUTE, "<aside");
			cls.cardBase = cnBaseOf(CARD, "Card");
			cls.card = classAfterTag(PANEL, "<Card ");
			cls.cardBodyBase = cnBaseOf(CARD, "CardContent");
			cls.cardBody = classAfterTag(PANEL, "<CardContent");
			cls.group = classContaining(GROUP, "flex flex-wrap gap-2");
			cls.badgeBase = classLiteralContaining(BADGE, "inline-flex w-fit");
			cls.badgeSecondary = classLiteralContaining(
				BADGE,
				"bg-secondary text-secondary-foreground",
			);
			// The four elements under test are found by fragments that contain
			// NONE of the tokens the controls below strip (`max-w-full`,
			// `flex-1`, `truncate`, `min-w-0`). Keyed on the token itself, a
			// mutation that removes it fails HERE, in the reader, as one hook
			// error — the grep half — and the browser never gets to show the
			// badge breaking. `bun run mutate` on each token must go red in the
			// geometry cases, not in this lookup.
			cls.badge = classContaining(GROUP, "py-1 pr-1 pl-2");
			cls.caption = classContaining(GROUP, "font-normal text-muted-foreground");
			cls.namePlain = classMatching(
				GROUP,
				/className="([^"]*)"\s+title=\{g\.name\}/g,
			);
			cls.nameButton = classContaining(
				GROUP,
				"items-center rounded-sm underline",
			);
			cls.nameButtonText = classMatching(
				GROUP,
				/aria-hidden\s+className="([^"]*)"\s*>\s*\{g\.name\}/g,
			);
			cls.remove = classContaining(GROUP, "size-6 items-center justify-center");
			cls.toggle = classLiteralContaining(
				TOGGLE,
				"inline-flex shrink-0 overflow-hidden",
			);
			cls.segment = classLiteralContaining(
				TOGGLE,
				"inline-flex min-h-6 items-center px-2",
			);
			cls.segmentOff = classLiteralContaining(
				TOGGLE,
				"text-muted-foreground hover:bg-muted",
			);
			// Every fixture's candidates, so the controls below are styled by the
			// same stylesheet as the shipped markup. The stripped variants add no
			// class, so the shipped set covers them.
			const s = shipped();
			css = await buildAppCss(
				candidatesIn(
					[
						desktopFixture(officerView(s, false, LONG_NAME)),
						desktopFixture(officerView(s, true, LONG_NAME)),
					].join(""),
				),
			);
		});

		it("reads the shipped class strings out of source", () => {
			// Vacuity floor: an empty class string would make every measurement
			// below describe an unstyled document.
			expect(cls.badge).toContain("max-w-full");
			expect(cls.badgeBase).toContain("overflow-hidden");
			expect(cls.badgeBase).toContain("whitespace-nowrap");
			expect(cls.caption).toContain("flex-1");
			expect(cls.caption).toContain("truncate");
			expect(cls.namePlain).toContain("truncate");
			expect(cls.nameButton).toContain("min-w-0");
			expect(cls.nameButtonText).toContain("truncate");
			expect(cls.rail).toMatch(/lg:w-\[\d+px\]/);
			expect(cls.cardBodyBase).toContain("px-6");
			expect(cls.toggle).toContain("shrink-0");
		});

		describe("a guest speaker with a 120-character home club, as an officer sees them", () => {
			for (const [where, fixture] of [
				["on the 340px desktop rail", desktopFixture],
				["on a 375px phone", phoneFixture],
				["on a 768px tablet", tabletFixture],
			] as const) {
				for (const nameAsControl of [false, true]) {
					const how = nameAsControl ? "name as the edit control" : "plain name";
					it(`${where}, ${how}: the badge stays inside the rail and the caption gives way`, () => {
						const m = measure(fixture(officerView(shipped(), nameAsControl)));
						expectInsideTheRail(m, `${where}, ${how}`);
						// The badge really was constrained — without this the rest passes
						// vacuously on a caption that happened to fit.
						expect(
							m.captionScrollWidth,
							"the caption should be wider than the room it got",
						).toBeGreaterThan(m.captionWidth);
						// And it gave way GRACEFULLY: it kept some room (the review's
						// shape is "the caption absorbs the shortfall", not "the caption
						// vanishes"), while the name kept all of its own.
						expect(m.captionWidth).toBeGreaterThan(0);
						expect(
							m.nameScrollWidth,
							`the name was truncated (${m.nameClientWidth}px of ${m.nameScrollWidth}px) while the caption still had ${m.captionWidth}px`,
						).toBeLessThanOrEqual(m.nameClientWidth);
					});
				}
			}
		});

		it("gives the caption the whole badge when there is no toggle, and nothing it does not need", () => {
			// A viewer without the toggle: the caption has the room, and the badge
			// is content-sized rather than stretched to the rail. `w-fit` and
			// `flex-1` have to agree here — a badge that always filled the rail
			// would read as a bar, not a chip.
			const short = measure(
				desktopFixture(
					badge(shipped(), {
						name: NAME,
						caption: SHORT_CAPTION,
						toggle: false,
						remove: false,
						nameAsControl: false,
					}),
				),
			);
			expectInsideTheRail(short, "short caption, no toggle");
			expect(short.captionScrollWidth).toBeLessThanOrEqual(short.captionWidth);
			expect(short.badgeWidth).toBeLessThan(short.groupClientWidth);
		});

		describe("a name too long for the rail", () => {
			// Pre-#1080 such a badge overflowed the rail (399px in 290px) and the
			// card body scrolled sideways to it. With the badge capped, the name
			// must TRUNCATE rather than push the toggle and the remove control past
			// the badge's clipped edge, where nothing can reach them.
			for (const nameAsControl of [false, true]) {
				const how = nameAsControl ? "as the edit control" : "as plain text";
				it(`${how}, with no caption: truncates and keeps both controls reachable`, () => {
					const m = measure(
						desktopFixture(
							badge(shipped(), {
								name: LONG_NAME,
								caption: null,
								toggle: true,
								remove: true,
								nameAsControl,
							}),
						),
					);
					expectInsideTheRail(m, `long name ${how}`);
					expect(
						m.nameScrollWidth,
						"the long name should have been truncated",
					).toBeGreaterThan(m.nameClientWidth);
				});
			}

			it("with a caption too: the caption goes first, then the name, controls intact", () => {
				const m = measure(
					desktopFixture(officerView(shipped(), false, LONG_NAME)),
				);
				expectInsideTheRail(m, "long name + caption");
				expect(m.captionWidth).toBe(0);
				expect(m.nameScrollWidth).toBeGreaterThan(m.nameClientWidth);
			});
		});

		describe("controls: the shipped markup with one class removed", () => {
			it("without `max-w-full` on the badge, the badge overflows the rail (the review's finding)", () => {
				const c = { ...shipped(), badge: strip(cls.badge, "max-w-full") };
				const desk = measure(desktopFixture(officerView(c, false)));
				expect(desk.badgeOverhang).toBeGreaterThan(0);
				expect(desk.groupScrollWidth).toBeGreaterThan(desk.groupClientWidth);
				expect(desk.bodyScrollWidth).toBeGreaterThan(desk.bodyClientWidth);
				const phone = measure(phoneFixture(officerView(c, false)));
				expect(phone.badgeOverhang).toBeGreaterThan(0);
			});

			it("without `truncate` on the caption, the caption cannot shrink and the controls are clipped", () => {
				const c = { ...shipped(), caption: strip(cls.caption, "truncate") };
				const m = measure(desktopFixture(officerView(c, false)));
				expect(m.badgeScrollWidth).toBeGreaterThan(m.badgeClientWidth);
				expect(m.toggleOverhang).toBeGreaterThan(0);
				expect(m.removeOverhang).toBeGreaterThan(0);
			});

			it("without `flex-1` on the caption, the NAME is squeezed while the caption keeps room", () => {
				// Basis `auto` shrinks name and caption in proportion to their
				// content, so a 72px name loses most of itself to a 797px caption.
				const c = { ...shipped(), caption: strip(cls.caption, "flex-1") };
				const m = measure(desktopFixture(officerView(c, false)));
				expect(m.nameScrollWidth).toBeGreaterThan(m.nameClientWidth);
				expect(m.captionWidth).toBeGreaterThan(0);
			});

			it("without `truncate` on the plain name, a long name clips the controls", () => {
				const c = { ...shipped(), namePlain: strip(cls.namePlain, "truncate") };
				const m = measure(
					desktopFixture(
						badge(c, {
							name: LONG_NAME,
							caption: null,
							toggle: true,
							remove: true,
							nameAsControl: false,
						}),
					),
				);
				expect(m.toggleOverhang).toBeGreaterThan(0);
				expect(m.removeOverhang).toBeGreaterThan(0);
			});

			it("without `min-w-0` on the name control, a long name clips the controls", () => {
				// The visible span's `truncate` is not enough on its own: Chrome
				// sizes a <button> to its content whatever its child's overflow says.
				const c = {
					...shipped(),
					nameButton: strip(cls.nameButton, "min-w-0"),
				};
				const m = measure(
					desktopFixture(
						badge(c, {
							name: LONG_NAME,
							caption: null,
							toggle: true,
							remove: true,
							nameAsControl: true,
						}),
					),
				);
				expect(m.toggleOverhang).toBeGreaterThan(0);
				expect(m.removeOverhang).toBeGreaterThan(0);
			});

			it("without `truncate` on the name control's text, a long name paints under the toggle", () => {
				const c = {
					...shipped(),
					nameButtonText: strip(cls.nameButtonText, "truncate"),
				};
				const m = measure(
					desktopFixture(
						badge(c, {
							name: LONG_NAME,
							caption: null,
							toggle: true,
							remove: true,
							nameAsControl: true,
						}),
					),
				);
				expect(m.nameOverToggle).toBeGreaterThan(0);
			});
		});
	},
);

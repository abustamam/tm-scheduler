// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineBadge } from "./offline-badge";

// The real hooks read `navigator.onLine` / `serviceWorker.controller`, neither
// of which jsdom lets us drive; the states themselves are covered by the hook.
const state = { online: true, offlineReady: true };
vi.mock("#/hooks/use-online-status", () => ({
	useOnlineStatus: () => state.online,
	useOfflineReady: () => state.offlineReady,
}));

describe("OfflineBadge", () => {
	beforeEach(() => {
		state.online = true;
		state.offlineReady = true;
		localStorage.clear();
	});
	afterEach(() => cleanup());

	// #361 — the online pill used to float `position: fixed` top-center, on top
	// of the agenda. It now flows wherever the host puts it (the print toolbar,
	// the present chrome cluster) so it never covers content.
	it("renders the online pill in normal flow, not pinned over the content", () => {
		render(
			<div data-testid="toolbar">
				<OfflineBadge id="m1" />
			</div>,
		);

		const pill = screen.getByText("Available offline");
		expect(pill.style.position).toBe("");
		expect(screen.getByTestId("toolbar").contains(pill)).toBe(true);
		// `no-print` lives in its own two-branch test below, which owns it; this
		// one is about position.
	});

	it("renders nothing while online without a service worker", () => {
		state.offlineReady = false;
		const { container } = render(<OfflineBadge id="m1" />);

		expect(container.textContent).toBe("");
	});

	// #726 — both branches, because `no-print` is the ONLY thing keeping either
	// indicator off a printed sheet, and the pill's branch is the one whose
	// styling this issue rewrote. Asserted per branch rather than once: the two
	// return different elements from different code paths.
	it("keeps `no-print` on both branches", () => {
		const { container: onlineEl } = render(<OfflineBadge id="m1" />);
		expect(onlineEl.firstElementChild?.className).toContain("no-print");

		cleanup();
		state.online = false;
		const { container: offlineEl } = render(<OfflineBadge id="m1" />);
		expect(offlineEl.firstElementChild?.className).toContain("no-print");
	});

	// #726 scoped itself to the online pill; the banner is #361's, deliberately
	// prominent, and this is what says the restyle did not drift into it.
	it("leaves the offline banner's styling untouched", () => {
		state.online = false;
		render(<OfflineBadge id="m1" />);

		const banner = screen.getByText(/^Offline · showing the last saved agenda/);
		expect(banner.style.fontSize).toBe("13px");
		expect(banner.style.fontWeight).toBe("600");
		expect(banner.style.color).toBe("rgb(124, 45, 18)");
		expect(banner.style.backgroundColor).toBe("rgba(255, 247, 237, 0.96)");
		expect(banner.style.border).toBe("1px solid rgba(234, 88, 12, 0.4)");
		// Still pinned, still top-center — the half #361 argued for.
		expect(banner.parentElement?.style.position).toBe("fixed");
		expect(banner.parentElement?.style.zIndex).toBe("30");
	});

	// #726 — the pill got quieter. These are the properties that carried the
	// loudness: a saturated green ink, a tinted fill, a green border, 600 weight
	// at 12px, and a 7px dot.
	//
	// RANGES, not ceilings. A bare `toBeLessThan` has no floor, so it passes at
	// 1px, weight 100 and a 0px dot — which is not "quieter", it is gone, and
	// #726's first acceptance criterion is that the pill stays legible at its
	// size. `CODING_STANDARDS.md` prescribes the two-sided absolute bound for
	// exactly this shape (the `CATASTROPHE_MS` entry). The band still leaves a
	// later taste pass room to move without rewriting the test.
	it("renders the pill quieter than the green chip it replaced", () => {
		render(<OfflineBadge id="m1" />);
		const pill = screen.getByText("Available offline");

		expect(pill.style.border).toBe("");
		const size = Number.parseFloat(pill.style.fontSize);
		expect(size).toBeGreaterThanOrEqual(10);
		expect(size).toBeLessThan(12);
		const weight = Number(pill.style.fontWeight);
		expect(weight).toBeGreaterThanOrEqual(400);
		expect(weight).toBeLessThan(600);
		// The dot is the pill's only other mark. It is the first child span.
		const dot = pill.firstElementChild as HTMLElement;
		const dotSize = Number.parseFloat(dot.style.width);
		expect(dotSize).toBeGreaterThanOrEqual(4);
		expect(dotSize).toBeLessThan(7);
		// Neutral, not saturated: R/G/B within a few points of each other rules
		// out the lime `#65a30d` and the green-tinted `#f0fdf4` fill alike.
		for (const channels of [
			rgb(pill.style.color),
			rgb(dot.style.backgroundColor),
		]) {
			expect(Math.max(...channels) - Math.min(...channels)).toBeLessThan(60);
		}
	});

	// #726's one constraint that is not taste. The component takes no host prop,
	// so ONE style has to stay readable on every ground it is mounted over, and
	// they run from the Print toolbar's white to the Present view's black
	// letterbox bar. jsdom loads no stylesheet and can see nothing about
	// legibility itself, so this composites the pill's own declared ground onto
	// each host ground and recomputes WCAG from the rendered values.
	//
	// What this CANNOT see, measured rather than assumed: at the pill's current
	// 0.85 alpha the floor is set by the ALPHA, not by any host. Pure black is
	// the darkest ground there is and still composites to 5.36:1, so no host
	// repaint can fail the loop below today — repainting `GROUND` to `#202020`
	// passes, correctly. The grounds are a live input with slack, not a dead
	// one: drop the alpha to 0.30 and this fails on `letterbox` immediately. So
	// what guards a host change TODAY is the extraction itself (the test below,
	// and the throws in `letterboxGround` / `hexConst` / `toolbarGround`); this
	// loop is what starts biting the moment the pill gets more transparent.
	it("keeps the pill readable on every ground it is mounted over", () => {
		// Vacuity floor: an empty or silently-shrunken `HOST_GROUNDS` passes the
		// loop below having checked nothing, so name the whole set first. The
		// extractors throw rather than yield a stale value, but nothing except
		// this catches a ground being dropped from the map.
		expect(Object.keys(HOST_GROUNDS).sort()).toEqual([
			"contentSlide",
			"letterbox",
			"splashBottom",
			"splashTop",
			"toolbar",
		]);

		render(<OfflineBadge id="m1" />);
		const pill = screen.getByText("Available offline");
		const ink = rgb(pill.style.color);
		const ground = rgba(pill.style.backgroundColor);

		for (const [where, host] of Object.entries(HOST_GROUNDS)) {
			const behind = composite(ground, rgbFromHex(host));
			const ratio = contrast(ink, behind);
			// AA for normal text. 11px is normal text, not "large".
			expect(
				ratio,
				`${where} (${host}): ${ratio.toFixed(2)}:1 behind ${pill.style.backgroundColor}`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	// The extraction above is code, and its own bugs are invisible to a green
	// run (`CODING_STANDARDS.md`, "a `*.guard.test.ts` is code — MUTATE IT").
	// This is what reports WHAT it read, so a host repaint shows up as a changed
	// value here rather than as a silent pass against a stale one.
	it("reads its host grounds out of the hosts themselves", () => {
		for (const [where, hex] of Object.entries(HOST_GROUNDS)) {
			expect(hex, where).toMatch(/^#[0-9a-fA-F]{3,6}$/);
		}
		// The two ends of the range the single pill style has to span. Named
		// rather than merely counted: the black bar is the contrast FLOOR, and a
		// map that still has five keys but lost its darkest ground would pass the
		// set assertion above while measuring nothing that binds.
		expect(HOST_GROUNDS.letterbox).toBe("#000000");
		// White specifically, because `offline-badge.tsx` documents a property
		// that depends on it: the chip composites to the toolbar's own colour
		// there and reads as bare text. A toolbar repainted off-white makes that
		// comment false, which is worth a look even though the pill stays legible.
		expect(HOST_GROUNDS.toolbar.toLowerCase()).toMatch(/^#(fff|ffffff)$/);
	});

	// The genuinely-offline banner is information the reader needs mid-meeting,
	// so it stays pinned and prominent regardless of where it is mounted.
	it("keeps the offline banner pinned over the page", () => {
		localStorage.setItem(
			"gavelup-offline-visit:m1",
			String(Date.now() - 5 * 60_000),
		);
		state.online = false;
		render(
			<div data-testid="toolbar">
				<OfflineBadge id="m1" />
			</div>,
		);

		const banner = screen.getByText(/^Offline · showing the agenda as of/);
		expect(banner.textContent).toContain("5 minutes ago");
		expect(banner.parentElement?.style.position).toBe("fixed");
	});
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PRESENT = resolve(HERE, "meeting-present.tsx");
const PRINT_THEME = resolve(HERE, "print-theme.tsx");

/**
 * The host file's source, with a vacuity floor on the read itself.
 *
 * Read rather than IMPORTED, and that is a measurement rather than a
 * preference: `meeting-present.tsx` imports `getVoteParticipation` from
 * `#/server/voting`, which reaches `#/db` and throws `DATABASE_URL is not set`
 * the moment the module is evaluated. Importing the palette would make this
 * unit test require a database env var to run at all — and per CLAUDE.md a
 * database-less run SKIPS rather than fails, so the one gate on #726's
 * non-taste constraint would vanish from a green suite. Reading the source is
 * what `pinned-column-reachability.test.ts` does with its class strings for
 * the same reason.
 */
function hostSource(path: string): string {
	const raw = readFileSync(path, "utf8");
	if (raw.length < 500) throw new Error(`${path}: read ${raw.length} bytes`);
	return raw;
}

/** A `const NAME = "#rgb";` / `"#rrggbb";` declaration, appearing exactly once. */
function hexConst(src: string, name: string): string {
	const hits = [
		...src.matchAll(new RegExp(`const ${name} = "(#[0-9a-fA-F]{3,6})";`, "g")),
	];
	if (hits.length !== 1) {
		throw new Error(`${name}: expected 1 declaration, found ${hits.length}`);
	}
	return hits[0][1];
}

/**
 * The Print toolbar's fill, anchored INSIDE `PRINT_TOOLBAR_STYLE` rather than
 * grepped from byte zero (`CODING_STANDARDS.md`: anchor every search inside
 * the construct you mean).
 *
 * Grepped before writing that: `print-theme.tsx` carries six `background:`
 * keys, and the toolbar's does happen to be the first QUOTED hex one today —
 * so the anchor is not load-bearing this minute. It is still the right shape,
 * because `PAGE_OUTER` declares `background: "#fff"` sixty lines later, the
 * SAME value. An unanchored search that started matching the wrong one would
 * return an identical string and nothing would fail.
 *
 * Read out of the object rather than exported from it on purpose: that object
 * carries an explicit "module-private, `PrintToolbar` is the surface" comment,
 * so exporting it to satisfy a test would puncture a decision the host made.
 */
function toolbarGround(src: string): string {
	const start = src.indexOf("const PRINT_TOOLBAR_STYLE");
	if (start < 0) throw new Error("PRINT_TOOLBAR_STYLE: not found");
	const end = src.indexOf("\n};", start);
	if (end < 0) throw new Error("PRINT_TOOLBAR_STYLE: unterminated");
	const hit = src
		.slice(start, end)
		.match(/background:\s*"(#[0-9a-fA-F]{3,6})"/);
	if (!hit) throw new Error("PRINT_TOOLBAR_STYLE: no hex background");
	return hit[1];
}

/**
 * Tailwind ground classes this test knows the hex for. Deliberately tiny: an
 * unknown class THROWS below rather than defaulting, so repainting the Present
 * shell fails here instead of quietly measuring against black forever.
 */
const TAILWIND_GROUNDS: Record<string, string> = { "bg-black": "#000000" };

/**
 * The Present view's letterbox ground — the only one of the four that cannot
 * be a constant, because it is a Tailwind class on the shell.
 *
 * Anchored on `{offlineBadge}`, the actual mount, so this cannot drift onto
 * some other `fixed inset-0` element: the shell is the single such className
 * before the badge is placed into it.
 */
function letterboxGround(src: string): string {
	const mounts = [...src.matchAll(/\{offlineBadge\}/g)];
	if (mounts.length !== 1) {
		throw new Error(`{offlineBadge}: expected 1 mount, found ${mounts.length}`);
	}
	const shells = [
		...src
			.slice(0, mounts[0].index)
			.matchAll(/className="([^"]*\bfixed inset-0\b[^"]*)"/g),
	];
	if (shells.length !== 1) {
		throw new Error(`Present shell: expected 1, found ${shells.length}`);
	}
	const painted = shells[0][1].split(/\s+/).filter((c) => c.startsWith("bg-"));
	if (painted.length !== 1) {
		throw new Error(`Present shell paints ${painted.length} bg- classes`);
	}
	const hex = TAILWIND_GROUNDS[painted[0]];
	if (!hex) {
		throw new Error(`${painted[0]}: add its hex to TAILWIND_GROUNDS`);
	}
	return hex;
}

/**
 * The five grounds the pill can be mounted over, READ OUT OF THE HOSTS rather
 * than copied here. A copy is not a gate: a host repainting its chrome leaves a
 * copy green against a value that no longer exists.
 *
 * Only two mounts exist (`present.tsx:121`, `print.tsx:286`), which is what
 * makes this set closed:
 *
 * - `toolbar`: `PRINT_TOOLBAR_STYLE`'s fill, the Print host.
 * - `letterbox`: the Present shell's `bg-black`. The badge cluster is
 *   positioned against the VIEWPORT, so on a display that is not 16:9 the pill
 *   sits on the bar rather than on the slide. Darkest ground, so the floor.
 * - `contentSlide`: `GROUND`, the off-white a content slide paints.
 * - `splashTop` / `splashBottom`: the dark splash is a GRADIENT, so its ground
 *   is a range, not a point. The pill sits at the top; the bottom is carried as
 *   a free stricter bound.
 */
const HOST_GROUNDS: Record<string, string> = (() => {
	const present = hostSource(PRESENT);
	return {
		toolbar: toolbarGround(hostSource(PRINT_THEME)),
		letterbox: letterboxGround(present),
		contentSlide: hexConst(present, "GROUND"),
		splashTop: hexConst(present, "NAVY_GRADIENT_TOP"),
		splashBottom: hexConst(present, "NAVY_GRADIENT_BOTTOM"),
	};
})();

/** `#rgb` or `#rrggbb`. */
function rgbFromHex(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	const full =
		h.length === 3
			? h
					.split("")
					.map((c) => c + c)
					.join("")
			: h;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex: ${hex}`);
	return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
		number,
		number,
		number,
	];
}

/**
 * `rgb(r, g, b)` as jsdom serialises it. The prefix check is load-bearing: the
 * digit scan alone reads an unnormalised `#94a3b8` as `[94, 3, 8]` instead of
 * throwing, which would sail through the neutrality assertion above.
 */
function rgb(value: string): [number, number, number] {
	if (!value.startsWith("rgb(")) throw new Error(`not an rgb(): ${value}`);
	const n = value.match(/[\d.]+/g);
	if (!n || n.length < 3) throw new Error(`not a colour: ${value}`);
	return [Number(n[0]), Number(n[1]), Number(n[2])];
}

/** `rgba(r, g, b, a)`; a missing alpha is opaque. */
function rgba(value: string): [number, number, number, number] {
	if (!/^rgba?\(/.test(value)) throw new Error(`not an rgba(): ${value}`);
	const n = value.match(/[\d.]+/g);
	if (!n || n.length < 3) throw new Error(`not a colour: ${value}`);
	return [Number(n[0]), Number(n[1]), Number(n[2]), n[3] ? Number(n[3]) : 1];
}

/** Source-over: what the eye actually sees where the two overlap. */
function composite(
	[r, g, b, a]: [number, number, number, number],
	behind: [number, number, number],
): [number, number, number] {
	return [
		r * a + behind[0] * (1 - a),
		g * a + behind[1] * (1 - a),
		b * a + behind[2] * (1 - a),
	];
}

/** WCAG 2.x relative luminance / contrast ratio. */
function luminance([r, g, b]: [number, number, number]): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(
	a: [number, number, number],
	b: [number, number, number],
): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

// @vitest-environment jsdom
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
		expect(pill.className).toContain("no-print");
		expect(screen.getByTestId("toolbar").contains(pill)).toBe(true);
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
		expect(screen.getByText("Available offline").className).toContain(
			"no-print",
		);
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
	// at 12px, and a 7px dot. Pinned as an upper bound rather than as exact
	// values, so a later taste pass can keep moving in the quiet direction
	// without rewriting the test, but cannot walk back toward the green pill.
	it("renders the pill quieter than the green chip it replaced", () => {
		render(<OfflineBadge id="m1" />);
		const pill = screen.getByText("Available offline");

		expect(pill.style.border).toBe("");
		expect(Number.parseFloat(pill.style.fontSize)).toBeLessThan(12);
		expect(Number(pill.style.fontWeight)).toBeLessThan(600);
		// The dot is the pill's only other mark. It is the first child span.
		const dot = pill.firstElementChild as HTMLElement;
		expect(Number.parseFloat(dot.style.width)).toBeLessThan(7);
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
	it("keeps the pill readable on every ground it is mounted over", () => {
		render(<OfflineBadge id="m1" />);
		const pill = screen.getByText("Available offline");
		const ink = rgb(pill.style.color);
		const ground = rgba(pill.style.backgroundColor);

		for (const [where, host] of Object.entries(HOST_GROUNDS)) {
			const behind = composite(ground, host);
			const ratio = contrast(ink, behind);
			// AA for normal text. 11px is normal text, not "large".
			expect(
				ratio,
				`${where}: ${ratio.toFixed(2)}:1 behind ${pill.style.backgroundColor}`,
			).toBeGreaterThanOrEqual(4.5);
		}
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

/**
 * The four grounds the pill can be mounted over. Copied rather than imported
 * because two of them are module-private consts in their host file; the
 * citation is the point, so a host that repaints its chrome is findable from
 * here.
 *
 * - `toolbar`: `PRINT_TOOLBAR_STYLE.background` in `print-theme.tsx`.
 * - `letterbox`: the Present view's `bg-black` shell, `meeting-present.tsx`.
 *   The pill's cluster is positioned against the VIEWPORT, so on a display
 *   that is not 16:9 it sits on the bar rather than on the slide. Darkest
 *   case, and therefore the floor.
 * - `contentSlide` / `darkSplash`: `GROUND` and `NAVY_GRADIENT_TOP`,
 *   `meeting-present.tsx:35-42`.
 */
const HOST_GROUNDS: Record<string, [number, number, number]> = {
	toolbar: [255, 255, 255],
	letterbox: [0, 0, 0],
	contentSlide: [0xf3, 0xf4, 0xf4],
	darkSplash: [0x0a, 0x4f, 0x78],
};

/** `rgb(r, g, b)` as jsdom serialises it. */
function rgb(value: string): [number, number, number] {
	const n = value.match(/[\d.]+/g);
	if (!n || n.length < 3) throw new Error(`not a colour: ${value}`);
	return [Number(n[0]), Number(n[1]), Number(n[2])];
}

/** `rgba(r, g, b, a)`; a missing alpha is opaque. */
function rgba(value: string): [number, number, number, number] {
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

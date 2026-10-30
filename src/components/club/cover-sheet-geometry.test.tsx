// @vitest-environment jsdom

// AC 5 (#1439): at 375px the "Who can cover?" sheet has no horizontal
// overflow and every button is 44px tall. The markup is the REAL CoverSheet,
// mounted in jsdom and serialised (portal included); headless Chrome then
// lays it out with the app's compiled Tailwind. No hand-typed classes.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/cover", () => ({
	askForCover: vi.fn(),
	releaseOwnSlotForCover: vi.fn(),
	undoReleaseForCover: vi.fn(),
	loadCoverCandidates: vi.fn(async () => [
		{
			memberId: "a",
			name: "Bartholomew Featherstonehaugh-Cholmondeley the Third",
			lastServedAt: null,
		},
		{ memberId: "b", name: "Sam Lee", lastServedAt: null },
	]),
}));

import { CoverSheet, type CoverSlot } from "#/components/club/cover-sheet";
import {
	buildAppCss,
	candidatesIn,
	renderAndReadTitle,
} from "#/test/pinned-column-scroll";
import { CHROME_TEST_TIMEOUT_MS, findChrome } from "#/test/print-page-count";

const hasChrome = findChrome() !== null;

const slot = (id: string, roleLabel: string): CoverSlot => ({
	slotId: id,
	meetingId: "22222222-2222-4222-8222-222222222222",
	roleLabel,
	scheduledAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
	clubSlug: "demo",
	urlKey: "2026-11-04",
	timeZone: "UTC",
});

afterEach(cleanup);

describe("cover sheet geometry harness availability", () => {
	it("has a browser when running in CI", () => {
		if (!process.env.CI) return;
		expect(hasChrome).toBe(true);
	});
});

describe.skipIf(!hasChrome)(
	"the cover sheet at 375px",
	{ timeout: CHROME_TEST_TIMEOUT_MS },
	() => {
		async function measure(slots: CoverSlot[]) {
			render(<CoverSheet slots={slots} onClose={() => {}} />);
			await screen.findByText(/Sam Lee/);
			const html = document.body.innerHTML;
			const css = await buildAppCss(candidatesIn(html));
			const script = `<script>
				const btns=[...document.querySelectorAll("button")].filter(b=>b.textContent.trim()&&!b.closest("[data-slot=sheet-close]")&&b.getAttribute("data-slot")==="button");
				const hs=btns.map(b=>Math.round(b.getBoundingClientRect().height));
				const dlg=document.querySelector("[role=dialog]").getBoundingClientRect();
				document.title="doc="+(document.documentElement.scrollWidth>innerWidth)
					+";dlgOver="+(dlg.right-innerWidth)
					+";n="+btns.length+";minH="+Math.min(...hs);
			</script>`;
			const title = renderAndReadTitle({
				bodyHtml: html,
				css,
				script,
				viewport: { width: 375, height: 812 },
				tmpPrefix: "cover-sheet-",
			});
			const num = (k: string) =>
				Number(new RegExp(`${k}=([-\\d.]+)`).exec(title)?.[1]);
			return {
				scrolls: /doc=true/.test(title),
				dialogOver: num("dlgOver"),
				buttons: num("n"),
				minHeight: num("minH"),
			};
		}

		it("one role: no horizontal overflow, every button 44px tall", async () => {
			const r = await measure([slot("s1", "Timer")]);
			expect(r.buttons).toBeGreaterThanOrEqual(3);
			expect(r.scrolls).toBe(false);
			expect(r.dialogOver).toBeLessThanOrEqual(0.5);
			expect(r.minHeight).toBeGreaterThanOrEqual(44);
		});

		it("several roles: the role chips wrap instead of overflowing", async () => {
			const r = await measure([
				slot("s1", "Timer"),
				slot("s2", "Ah-Counter"),
				slot("s3", "Grammarian"),
				slot("s4", "Table Topics Master"),
			]);
			expect(r.scrolls).toBe(false);
			expect(r.dialogOver).toBeLessThanOrEqual(0.5);
			expect(r.minHeight).toBeGreaterThanOrEqual(44);
		});
	},
);

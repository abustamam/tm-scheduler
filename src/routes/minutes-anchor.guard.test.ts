// The meeting toolbar's completed-phase primary is a jump link, and BOTH ends
// of that contract are invisible to every other gate in this repo (#541).
//
// The toolbar renders `<Link to="." hash={MINUTES_ANCHOR_ID}>`; the route puts
// `id={MINUTES_ANCHOR_ID}` on the minutes section. Delete or rename the route's
// id and nothing goes red: typecheck sees no relationship between a `hash`
// string and a DOM `id`, the toolbar's own test
// (`meeting-toolbar.test.tsx`) hardcodes `#minutes` and therefore pins only ITS
// side, the route component cannot render standalone in jsdom (loader + server
// fns), and the print page-count harness never loads this screen surface. The
// result would be a fixed-position primary CTA that scrolls nowhere, shipping
// green.
//
// So this is a source grep, and it pins the CONSTANT rather than the string it
// currently expands to: an `id="minutes"` literal would satisfy a string check
// while being exactly the drift the shared constant exists to prevent.
//
// COMMENT-BLIND (`readSource`) is mandatory here — every assertion below is of
// the "this pattern must BE present" form, where a file that merely MENTIONS
// the pattern in a comment is a false PASS. Both files being read carry
// comments that name `MINUTES_ANCHOR_ID` while explaining the contract (the
// paragraph above is one of them), so a raw read would keep this suite green
// with the real code deleted. See `#/test/guard-source`.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readSource } from "#/test/guard-source";

const ROUTES = dirname(fileURLToPath(import.meta.url));

// Cross-directory reads resolve from this file, the same way
// `print-page-reset.guard.test.ts` resolves its route paths.
const ROUTE = resolve(ROUTES, "club.$clubId.meeting.$meetingId.tsx");
const TOOLBAR = resolve(ROUTES, "../components/club/meeting-toolbar.tsx");

describe("the Minutes jump anchor (#541 D2)", () => {
	it("the meeting route marks the minutes section with the shared constant", () => {
		expect(
			readSource(ROUTE),
			"the meeting route must render `id={MINUTES_ANCHOR_ID}` on the minutes " +
				"section — the toolbar's completed-phase primary anchors there, and a " +
				"removed or hand-written id breaks it silently.",
		).toContain("id={MINUTES_ANCHOR_ID}");
	});

	it("the anchored section reserves room for the sticky header", () => {
		// Without a scroll margin the sticky header lands ON the section heading
		// after the jump. jsdom performs no layout, so nothing else can see this.
		expect(
			readSource(ROUTE),
			"the anchored minutes section needs a `scroll-mt-*` utility so the " +
				"sticky header (taller under the impersonation banner) does not cover " +
				"it once the primary scrolls there.",
		).toContain("scroll-mt-");
	});

	it("the toolbar links to the constant, not a raw '#minutes' string", () => {
		// The other half of the contract. `meeting-toolbar.test.tsx` asserts the
		// rendered href contains `#minutes`, which a hardcoded string satisfies
		// just as well — this is what stops the two ends from drifting apart.
		expect(
			readSource(TOOLBAR),
			"the toolbar's Minutes primary must build its hash from " +
				"MINUTES_ANCHOR_ID so it cannot drift from the route's section id.",
		).toContain("MINUTES_ANCHOR_ID");
	});

	it("both the loaded-minutes branch AND the degrade fallback carry the anchor", () => {
		// The toolbar's Minutes primary is gated on `showsMinutesPrimary`, but
		// the loader degrades ANY getMinutes failure to EMPTY_MINUTES
		// (visible=false) independent of canManage — so an admin on a completed
		// meeting can hold the CTA while `minutes.visible` is false. The route
		// renders a second section (with an explanatory line) for exactly that
		// state, and it must carry the SAME id, or the CTA click goes dead
		// again the moment the primary render swallows a getMinutes failure
		// (spec review of aa106b3, #541).
		const matches = readSource(ROUTE).match(/id=\{MINUTES_ANCHOR_ID\}/g) ?? [];
		expect(
			matches.length,
			"expected `id={MINUTES_ANCHOR_ID}` on both the loaded-minutes " +
				"section and the getMinutes-degrade fallback section — found " +
				`${matches.length} occurrence(s). Dropping the fallback's id ` +
				"re-opens the dead-CTA-on-degrade hole invisibly to every other gate.",
		).toBeGreaterThanOrEqual(2);
	});

	// ── Route→component wiring pins (final whole-diff review, #541) ──────────
	//
	// The PR moved ~274 lines of inline, reviewable JSX onto props of two new
	// components. The components are exhaustively tested; the WIRING is
	// invisible to the suite — the route cannot render in jsdom, and the final
	// review demonstrated three simultaneous miswirings (canManage instead of
	// effectiveCanManage — the #320 preview-as-member regression; hasIdentity
	// hardcoded true — undoing review 1A's guest gate; the fallback keyed on
	// the wrong flag) shipping with typecheck, lint and 3,530 tests all green.
	// Same "must BE present" direction as everything above, so readSource.
	it("the toolbar receives the PREVIEW-AWARE manage flag, not the raw one", () => {
		expect(
			readSource(ROUTE),
			"the toolbar must get `canManage={effectiveCanManage}` — raw " +
				"canManage keeps officer controls visible in preview-as-member " +
				"mode (#320's regression, reachable again through this one prop).",
		).toContain("canManage={effectiveCanManage}");
	});

	it("the toolbar's identity gate is wired to the real identity", () => {
		expect(
			readSource(ROUTE),
			"the toolbar must get `hasIdentity={!!myId}` — anything truthier " +
				"hands anonymous guests the phase primary, undoing review 1A.",
		).toContain("hasIdentity={!!myId}");
	});

	it("the degrade fallback keys on the same preview-aware flag as the CTA", () => {
		expect(
			readSource(ROUTE),
			"the fallback section must render on `showsMinutesPrimary(phase, " +
				"effectiveCanManage)` — the CTA and its anchor target must flip " +
				"together in preview-as-member mode.",
		).toContain("showsMinutesPrimary(phase, effectiveCanManage)");
	});
});

import { describe, expect, it } from "vitest";
import { NAV_DESTINATIONS, visibleDestinations } from "./nav-destinations";
import { activeShortcuts, SHORTCUTS } from "./shortcuts";

describe("SHORTCUTS registry", () => {
	// protects=every shortcut's `to` is a real NAV_DESTINATIONS key so no path is retyped; fails_when=a key is misspelled or removed from the nav registry (grant agreement is the test below); no_claim=the route renders
	it("every `to` is a real destination key", () => {
		const byKey = new Map(NAV_DESTINATIONS.map((d) => [d.key as string, d]));
		for (const s of SHORTCUTS) {
			if (!s.to) continue;
			const d = byKey.get(s.to);
			expect(d, `${s.keys} -> ${s.to}`).toBeDefined();
			expect(d?.grant, `${s.keys} grant`).toBeDefined();
		}
	});

	// protects=no two shortcuts answer the same keys, and no single key shadows a sequence start; fails_when=a duplicate or a bare `g` is added; no_claim=browser-reserved keys
	it("keys are unique and no single-key shortcut is `g`", () => {
		const keys = SHORTCUTS.map((s) => s.keys);
		expect(new Set(keys).size).toBe(keys.length);
		expect(keys).not.toContain("g");
	});

	// protects=a grant-gated shortcut is active exactly when its destination is visible in the sidebar; fails_when=activeShortcuts and visibleDestinations disagree; no_claim=the keys do anything
	it("activeShortcuts agrees with the sidebar's visibility for every grant combination", () => {
		for (const hasOffice of [false, true])
			for (const isOfficer of [false, true])
				for (const isSuperadmin of [false, true]) {
					const grants = { hasOffice, isOfficer, isSuperadmin };
					const visible = new Set(
						visibleDestinations(grants).map((d) => d.key as string),
					);
					for (const s of activeShortcuts(grants)) {
						if (s.to) expect(visible.has(s.to)).toBe(true);
					}
					for (const s of SHORTCUTS) {
						if (s.to && visible.has(s.to)) {
							expect(activeShortcuts(grants)).toContain(s);
						}
					}
				}
	});
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Structural authz guard (#340): setContacted/clearContacted are officer-only
// writes to meeting_outreach and must stay gated admin-only + meeting-not-locked
// (ADR-0012). A true behavioral test isn't possible — a createServerFn handler
// can't be invoked outside a request context in vitest — and
// outreach.integration.test.ts exercises the DB logic directly, bypassing
// requireClubRole/assertMeetingNotLocked entirely. So, like
// meetings-contact-gate.guard.test.ts, this reads the REAL source (not a
// mirror) and asserts the gate wiring is present on both handlers, catching a
// silent weakening (e.g. downgraded to ["member"], or the lock check dropped)
// that the integration test would never surface.
describe("outreach write-fn authz gating (#340)", () => {
	const src = readFileSync(resolve(__dirname, "outreach.ts"), "utf8");

	function handlerBody(exportName: string): string {
		const start = src.indexOf(`export const ${exportName}`);
		if (start === -1) {
			throw new Error(`${exportName} not found in outreach.ts`);
		}
		// Bounded by the next top-level export (or EOF) so each assertion is
		// scoped to this handler, not the whole file.
		const nextExport = src.indexOf("\nexport const", start + 1);
		return src.slice(start, nextExport === -1 ? src.length : nextExport);
	}

	for (const fn of ["setContacted", "clearContacted"]) {
		it(`${fn} requires the admin club role`, () => {
			const body = handlerBody(fn);
			expect(body).toMatch(/requireClubRole\([^)]*\[["']admin["']\]\)/);
		});

		it(`${fn} is not gated on member-only role`, () => {
			const body = handlerBody(fn);
			expect(body).not.toMatch(/requireClubRole\([^)]*\[["']member["']\]\)/);
		});

		it(`${fn} asserts the meeting isn't locked`, () => {
			const body = handlerBody(fn);
			expect(body).toContain("assertMeetingNotLocked(");
		});
	}

	it('never gates a write on ["member"] anywhere in the module', () => {
		expect(src).not.toContain('["member"]');
	});
});

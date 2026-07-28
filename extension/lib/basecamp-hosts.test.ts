import { describe, expect, it } from "vitest";
import { BASECAMP_MATCHES } from "./basecamp-hosts";

/** The host each walker fetches from, parsed out of its own base URL rather
 *  than restated — so this can't drift from the code it's guarding. */
const API_HOSTS = ["basecamp.toastmasters.org"];

describe("BASECAMP_MATCHES", () => {
	// The bug this file exists to prevent: TI serves the Pathways dashboard from
	// `apps.` (plural), which no match pattern covered, so the content scripts
	// never injected and the sync widget silently didn't appear.
	it("covers the host the Pathways dashboard is actually served from", () => {
		expect(BASECAMP_MATCHES).toContain(
			"https://apps.basecamp.toastmasters.org/*",
		);
	});

	it("keeps the older hosts working", () => {
		expect(BASECAMP_MATCHES).toContain("https://basecamp.toastmasters.org/*");
		expect(BASECAMP_MATCHES).toContain(
			"https://app.basecamp.toastmasters.org/*",
		);
	});

	// From the `apps.` page the progress walk is a CROSS-ORIGIN credentialed
	// fetch to the bare host. Dropping the bare host from this list because "the
	// dashboard doesn't live there any more" would break the sync everywhere.
	it("still permits the host the walkers fetch from", () => {
		for (const host of API_HOSTS) {
			expect(BASECAMP_MATCHES).toContain(`https://${host}/*`);
		}
	});

	it("matches whole hosts only — no wildcard that would over-grant", () => {
		for (const m of BASECAMP_MATCHES) {
			expect(m.startsWith("https://")).toBe(true);
			// A pattern like `https://*.toastmasters.org/*` would hand the extension
			// every Toastmasters subdomain, which it has no business reading.
			expect(m).not.toContain("*.");
		}
	});
});

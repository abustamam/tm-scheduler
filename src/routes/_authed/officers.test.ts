// The /officers bounce (#542): this beforeLoad is the ONLY place the
// non-officer → /dashboard redirect lives, and signin.tsx sends EVERYONE here
// by default — so a plain member's whole post-login path is this one guard.
// The destination used to be /roster (a manage surface); a regression would
// strand members there again. `homeRedirectTarget` (the `/` beforeLoad's half
// of the same decision) has its own suite in `#/lib/home-route.test.ts`; this
// file covers the other half of the pair.
import { describe, expect, it, vi } from "vitest";

// The route file imports the onboarding-checklist server-fn module, whose
// guard chain reaches `#/db` at import time (throws "DATABASE_URL is not set"
// in a unit context). The beforeLoad under test never calls it — only the
// loader does, and the loader never runs here.
vi.mock("#/server/onboarding-checklist", () => ({
	getOnboardingChecklist: vi.fn(),
}));

import { Route } from "./officers";

/** Minimal authed-shell context: the shape `effectiveAdminClub` reads. */
function guardContext(over: {
	clubRole: "admin" | "member";
	officerCount: number;
}) {
	return {
		clubs: [
			{
				clubId: "club-1",
				name: "Harbor City Speakers",
				clubNumber: null,
				clubRole: over.clubRole,
			},
		],
		activeClubId: "club-1",
		officerPositions: Array.from({ length: over.officerCount }, () => ({
			position: "vpe",
		})),
	};
}

async function runBeforeLoad(context: ReturnType<typeof guardContext>) {
	const beforeLoad = Route.options.beforeLoad as unknown as (args: {
		context: ReturnType<typeof guardContext>;
	}) => unknown;
	if (!beforeLoad) throw new Error("officers route lost its beforeLoad guard");
	return await beforeLoad({ context });
}

describe("/officers beforeLoad (#542)", () => {
	it("bounces a plain member to /dashboard (was /roster)", async () => {
		let thrown: unknown;
		try {
			await runBeforeLoad(
				guardContext({ clubRole: "member", officerCount: 0 }),
			);
		} catch (e) {
			thrown = e;
		}
		// TanStack's redirect() throws a Response carrying the nav options — the
		// `to` on it is the load-bearing assertion.
		expect(thrown).toBeInstanceOf(Response);
		expect((thrown as Response & { options: { to?: string } }).options.to).toBe(
			"/dashboard",
		);
	});

	it("keeps a stored-admin member on the officer home (returns the admin club)", async () => {
		const result = await runBeforeLoad(
			guardContext({ clubRole: "admin", officerCount: 0 }),
		);
		expect(result).toMatchObject({ adminClub: { clubId: "club-1" } });
	});

	it("keeps an elected officer WITHOUT the stored admin role too (#265 parity)", async () => {
		const result = await runBeforeLoad(
			guardContext({ clubRole: "member", officerCount: 1 }),
		);
		expect(result).toMatchObject({ adminClub: { clubId: "club-1" } });
	});
});

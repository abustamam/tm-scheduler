/**
 * `/admin/import-history` page gate (#1492, AC 13).
 *
 * protects=an effective admin reaches the page for the ACTIVE club and a plain
 * member is redirected to /dashboard;
 * fails_when=the guard admits a plain member, or resolves another club;
 * no_claim=the server fns behind the panel re-ask the rule themselves
 * (`history-import-authz.integration.test.ts`); this is only the page gate.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("#/server/history-import", () => ({
	listEasySpeakImports: vi.fn(),
	uploadEasySpeakBundle: vi.fn(),
	previewEasySpeakImport: vi.fn(),
	applyEasySpeakImport: vi.fn(),
	importEasySpeakSpeechRequests: vi.fn(),
	importEasySpeakMentors: vi.fn(),
}));

import { Route } from "./import-history";

const CLUB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
type Role = "admin" | "member";
/** Two clubs, the first NOT the active one, so the first-club fallback cannot pass for the guard. */
const context = (
	activeRole: Role,
	officers: string[] = [],
	otherRole: Role = "member",
) => ({
	clubs: [
		{ clubId: OTHER, name: "Club B", clubNumber: null, clubRole: otherRole },
		{ clubId: CLUB, name: "Club A", clubNumber: null, clubRole: activeRole },
	],
	activeClubId: CLUB,
	officerPositions: officers,
});
const run = (ctx: ReturnType<typeof context>) =>
	(
		Route.options.beforeLoad as unknown as (a: { context: unknown }) => {
			adminClub: { clubId: string };
		}
	)({ context: ctx });

describe("/admin/import-history beforeLoad", () => {
	// protects=an admin and an officer reach the page for the ACTIVE club, not the
	// first club in the list;
	// fails_when=the guard resolves another club (here clubs[0] is a different one);
	// no_claim=a plain member (next test).
	it("admits an admin and an officer, resolving the active club", () => {
		expect(run(context("admin")).adminClub.clubId).toBe(CLUB);
		expect(run(context("member", ["vpe"])).adminClub.clubId).toBe(CLUB);
	});

	// protects=a plain member of the active club is redirected even when they are
	// an admin of ANOTHER club;
	// fails_when=the guard admits on an admin role in any club, or checks clubs[0];
	// no_claim=the server fns re-ask the rule themselves.
	it("redirects a plain member of the active club to /dashboard, whatever they are elsewhere", () => {
		try {
			run(context("member", [], "admin"));
			expect.unreachable("a plain member got through");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			expect(
				(thrown as Response & { options: { to?: string } }).options.to,
			).toBe("/dashboard");
		}
	});
});

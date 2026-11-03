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
const context = (clubRole: "admin" | "member", officers: string[] = []) => ({
	clubs: [{ clubId: CLUB, name: "Club A", clubNumber: null, clubRole }],
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
	it("admits an admin and an officer, resolving the active club", () => {
		expect(run(context("admin")).adminClub.clubId).toBe(CLUB);
		expect(run(context("member", ["vpe"])).adminClub.clubId).toBe(CLUB);
	});

	it("redirects a plain member to /dashboard", () => {
		try {
			run(context("member"));
			expect.unreachable("a plain member got through");
		} catch (thrown) {
			expect(thrown).toBeInstanceOf(Response);
			expect(
				(thrown as Response & { options: { to?: string } }).options.to,
			).toBe("/dashboard");
		}
	});
});

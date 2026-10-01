/**
 * Source guard for the two places #910 reaches into `clubs.ts`, whose handler
 * bodies vitest cannot run.
 *
 * - `updateClubAgendaSettings` refuses a General Evaluator change while the
 *   club has a default agenda (spec D5). The rule lives in
 *   `assertGeChangeAllowed`, which is integration-tested; what only a guard can
 *   hold is that the handler CALLS it, after the admin gate and before the
 *   write. Delete the line and the disabled checkbox becomes the whole rule.
 * - `loadClubAgendaSettings` returns `adopted`, which is what disables that
 *   checkbox. Drop it and the page silently shows a live checkbox the server
 *   then refuses.
 *
 * Read comment-blind (`readSource`): each is a "must BE present" assertion.
 */
import { describe, expect, it } from "vitest";
import { readSource, serverFnBody } from "#/test/guard-source";

const CLUBS = readSource("src/server/clubs.ts");

describe("clubs.ts wiring for the club default agenda (#910)", () => {
	it("updateClubAgendaSettings checks the GE lock after the admin gate and before writing", () => {
		const body = serverFnBody(CLUBS, "updateClubAgendaSettings");
		const gate = body.indexOf(
			'await requireClubRole(currentUser.id, data.clubId, ["admin"])',
		);
		const lock = body.indexOf(
			"await assertGeChangeAllowed(data.clubId, data.geIntroducesFunctionaries)",
		);
		const write = body.indexOf("applyClubAgendaSettingsUpdate(data)");
		expect(gate).toBeGreaterThan(-1);
		expect(lock).toBeGreaterThan(gate);
		expect(write).toBeGreaterThan(lock);
	});

	it("loadClubAgendaSettings returns whether the club has adopted", () => {
		const body = serverFnBody(CLUBS, "loadClubAgendaSettings");
		expect(body).toContain("isClubAgendaAdopted(clubId)");
		expect(body).toMatch(/return \{ \.\.\.settings, adopted \}/);
	});
});

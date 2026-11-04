import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { EasySpeakBundleV3 } from "./easy-speak-bundle";
import {
	buildImportPlan,
	buildReconciliation,
	expectedFromBundle,
	type FoundSourceIds,
	type PlanContext,
} from "./easy-speak-import-plan";

/**
 * A bounded bundle (#1491) holds only the meetings since a month, with the whole
 * member list. Pins that the importer needs nothing from the older meetings'
 * absence: nobody is created, changed or asked about because of it, and the
 * reconciliation counts only what the bundle itself holds.
 * Pure: a bundle and a context in, a plan and a report out.
 */
const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);
const NOW = new Date("2026-10-12T12:00:00Z");
const ADA = {
	memberId: "00000000-0000-4000-8000-000000000001",
	name: "Ada Linked",
};
const TZ = "America/Los_Angeles";

function fullBundle(): EasySpeakBundleV3 {
	const bundle = JSON.parse(readFileSync(FIXTURE, "utf8")) as EasySpeakBundleV3;
	const recent = bundle.meetings.find((m) => m.esMeetingId === "644304");
	if (!recent) throw new Error("fixture changed");
	const meeting = (
		id: string,
		startsAt: string,
		role: string,
		who: { esUserId: string; name: string },
	) => ({
		...recent,
		esMeetingId: id,
		startsAt,
		roles: [{ role, slot: 1, holder: who }],
		attendance: [],
		guests: [],
		awards: [],
		tableTopics: [],
	});
	bundle.meetings = [
		meeting("644001", "2025-03-05T02:00:00.000Z", "Timer", {
			esUserId: "900777",
			name: "Oldie Timer",
		}),
		meeting("644304", "2026-09-23T02:00:00.000Z", "Toastmaster", {
			esUserId: "900200",
			name: "Ada Linked",
		}),
	];
	bundle.people = [];
	bundle.mentors = [];
	bundle.speechRequests = [];
	bundle.visitorsIntroduced = [];
	return bundle;
}

/** The same bundle restricted to the meetings since a month, as a bounded export holds it. */
function boundedBundle(): EasySpeakBundleV3 {
	const bundle = fullBundle();
	bundle.meetings = bundle.meetings.filter((m) => m.startsAt >= "2026-05");
	bundle.range = { fromMonth: "2026-05" };
	return bundle;
}

const ctx = (): PlanContext => ({
	now: NOW,
	clubTimezone: TZ,
	roster: [ADA],
	roleDefinitions: [],
	guestIds: new Set(),
	existingMeetings: [],
	refs: [],
});

describe("a bounded bundle against a club that holds the older history (#1491)", () => {
	// protects=a partial export never inventing, changing or asking about a person because older meetings are absent;
	// fails_when=the plan creates or asks about someone only an older meeting names, or changes a person it matched before;
	// no_claim=the apply's writes (history-import-logic.integration.test.ts); the context is hand-made, not a real club
	it("plans no outcome for a person named only by older meetings and changes nobody else", () => {
		const full = buildImportPlan(fullBundle(), ctx());
		const bounded = buildImportPlan(boundedBundle(), ctx());

		// The full bundle does name the older person, so the absence below is the bound, not the fixture.
		expect(full.people.some((p) => p.key === "es:900777")).toBe(true);
		expect(bounded.people.some((p) => p.key === "es:900777")).toBe(false);

		expect(bounded.unresolved).toEqual([]);
		expect(bounded.canApply).toBe(true);
		// Everyone the bounded plan does cover is planned exactly as the full plan plans them.
		expect(bounded.people.length).toBeGreaterThan(0);
		for (const p of bounded.people) {
			expect(p.outcome).toEqual(
				full.people.find((f) => f.key === p.key)?.outcome,
			);
		}
		expect(bounded.counts.newFormerMembers).toBe(0);
		expect(bounded.counts.meetings).toBe(1);
	});

	// protects=the reconciliation expecting only the bundle's own past meetings;
	// fails_when=an older meeting (absent from the bundle) is counted as missing, or the full bundle's expectation shrinks;
	// no_claim=the database's refs (the integration test); `found` is built from the expectation itself
	it("reconciles on the bundle's own meetings: reconciled with only those found", () => {
		const bundle = boundedBundle();
		const expected = expectedFromBundle(bundle, NOW, TZ, new Set());
		expect(expected.meetings).toEqual(["644304"]);
		expect(
			expectedFromBundle(fullBundle(), NOW, TZ, new Set()).meetings,
		).toEqual(["644001", "644304"]);

		const found: FoundSourceIds = {
			meeting: new Set(expected.meetings),
			roleAssignment: new Set(expected.roleAssignments.map((r) => r.sourceId)),
			speech: new Set(expected.speeches.map((s) => s.sourceId)),
			speechWithIntroduction: new Set(
				expected.speeches
					.filter((s) => s.hasIntroduction)
					.map((s) => s.sourceId),
			),
			award: new Set(expected.awards),
			tableTopic: new Set(expected.tableTopics),
			attendance: new Set(expected.attendance.map((a) => a.sourceId)),
		};
		const report = buildReconciliation({
			bundle,
			bundleSha256: "a".repeat(64),
			now: NOW,
			clubTimezone: TZ,
			found,
			failed: [],
			appliedMeetings: 1,
			skippedPeople: [],
			created: { guests: 0, roleDefinitions: [] },
		});
		expect(report.reconciled).toBe(true);
		expect(report.counts.find((c) => c.key === "meetings")).toMatchObject({
			bundle: 1,
			gavelup: 1,
		});
	});
});

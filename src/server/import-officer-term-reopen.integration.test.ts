/**
 * DB-backed tests for the one branch of `importPeopleAndMembers` that WRITES an
 * `officer_terms` row (#819), beside `import-members.integration.test.ts` which
 * covers the person/membership dedupe the rest of that function does.
 *
 * Why this branch gets a file of its own: an open officer term is a full
 * club-admin grant. `guards.ts` reads `getOpenOfficerPositions` and hands out
 * `admin` for ANY open row whatever `club_role` says (#202), so a statement
 * that opens one is a privilege write, not a roster detail — and this is the
 * only place in the app where a privilege write is driven by an uploaded file
 * rather than by a click on a named member.
 *
 * The cases below are the ones a "did the office land?" assertion cannot tell
 * apart. Seeding an office onto a membership that has never held one and
 * RE-OPENING one a human ended look identical at the row level: same table,
 * same position, same null `term_start`. What separates them is the history
 * already on the membership, so every case here sets that history up through
 * the real writer that produces it — `closeOpenOfficerTerms` for the convert
 * path (#805), `reconcileOfficerTerms` for the member edit form's checkboxes —
 * rather than by hand-inserting a closed row, so a change to what those writers
 * leave behind shows up here.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:…@localhost:5432/tm_test \
 *     bunx vitest run src/server/import-officer-term-reopen.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, members, officerTerms } from "#/db/schema";
import type { MappedMember } from "#/lib/members-csv";
import { cleanup, hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

/** Minimal mapped-CSV row builder (all fields default to null). */
function row(over: Partial<MappedMember>): MappedMember {
	return {
		customerId: null,
		name: "Unnamed",
		email: null,
		phone: null,
		joinedAt: null,
		originalJoinDate: null,
		officerPosition: null,
		currentPosition: null,
		...over,
	};
}

const presidentRow = {
	customerId: "PN-819",
	name: "Pat",
	officerPosition: "president" as const,
	currentPosition: "Club President",
};

describe.skipIf(!hasTestDb)(
	"import never re-opens an ended office (#819)",
	() => {
		let importPeopleAndMembers: typeof import("#/server/import-members-logic").importPeopleAndMembers;
		const clubIds: string[] = [];

		beforeEach(async () => {
			({ importPeopleAndMembers } = await import(
				"#/server/import-members-logic"
			));
			clubIds.length = 0;
		});

		afterEach(async () => {
			for (const id of clubIds) await cleanup(id, []);
		});

		async function club(): Promise<string> {
			const id = randomUUID();
			await testDb
				.insert(clubs)
				.values({ id, name: "Reopen Test", slug: `reopen-${id}` });
			clubIds.push(id);
			return id;
		}

		/** Open (current) offices for a membership — the set `guards.ts` grants
		 *  effective-admin from, read through the same predicate it uses. */
		async function openOffices(membershipId: string): Promise<string[]> {
			const rows = await testDb
				.select({ position: officerTerms.position })
				.from(officerTerms)
				.where(
					and(
						eq(officerTerms.membershipId, membershipId),
						isNull(officerTerms.termEnd),
					),
				);
			return rows.map((r) => r.position);
		}

		/** Ended offices, which are history and must stay exactly as the human
		 *  left them — a "fix" that DELETED the closed row would satisfy
		 *  `openOffices` alone while destroying the record
		 *  `applyUndoGuestConversion` counts. */
		async function endedOffices(membershipId: string): Promise<string[]> {
			const rows = await testDb
				.select({ position: officerTerms.position })
				.from(officerTerms)
				.where(
					and(
						eq(officerTerms.membershipId, membershipId),
						isNotNull(officerTerms.termEnd),
					),
				);
			return rows.map((r) => r.position);
		}

		/** Seed one member from a CSV row and return the membership id. */
		async function seedFromCsv(
			clubId: string,
			over: Partial<MappedMember>,
		): Promise<string> {
			await importPeopleAndMembers(clubId, [row(over)]);
			const [m] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(eq(members.clubId, clubId));
			if (!m) throw new Error("fixture: import created no membership");
			return m.id;
		}

		it("does not re-open a term the guest convert closed (#805)", async () => {
			const clubId = await club();
			const membershipId = await seedFromCsv(clubId, presidentRow);
			expect(await openOffices(membershipId)).toEqual(["president"]);

			// The convert path: a lapsed membership is woken up, and #805 ends the
			// open term in the same transaction because effective-admin is granted
			// off it. The admin was told so in the toast.
			const { closeOpenOfficerTerms } = await import("./officers-logic");
			await closeOpenOfficerTerms(testDb, membershipId);
			expect(await openOffices(membershipId)).toEqual([]);

			// The next roster export still names Pat President. Before #819 that
			// re-opened the term and handed club-admin straight back, with no
			// toast, no activity row and a null `term_start`.
			const stats = await importPeopleAndMembers(clubId, [row(presidentRow)]);

			expect(await openOffices(membershipId)).toEqual([]);
			expect(await endedOffices(membershipId)).toEqual(["president"]);
			expect(stats.skippedEndedOffice).toBe(1);
		});

		it("does not re-open a term the member edit form closed", async () => {
			const clubId = await club();
			const membershipId = await seedFromCsv(clubId, presidentRow);

			// The same shape reached by the deliberate act the issue names as the
			// only way back in: an admin unchecks every office on the member page.
			const { reconcileOfficerTerms } = await import("./officer-terms-logic");
			await reconcileOfficerTerms(testDb, membershipId, []);
			expect(await openOffices(membershipId)).toEqual([]);

			await importPeopleAndMembers(clubId, [row(presidentRow)]);

			expect(await openOffices(membershipId)).toEqual([]);
			expect(await endedOffices(membershipId)).toEqual(["president"]);
		});

		it("does not open a DIFFERENT office once one has been ended", async () => {
			// A per-position rule would pass the two cases above and fail here,
			// and the hole it leaves is the whole grant: effective-admin does not
			// care WHICH office is open, so re-opening the membership as Treasurer
			// restores exactly the access closing the presidency withdrew.
			const clubId = await club();
			const membershipId = await seedFromCsv(clubId, presidentRow);
			const { closeOpenOfficerTerms } = await import("./officers-logic");
			await closeOpenOfficerTerms(testDb, membershipId);

			const stats = await importPeopleAndMembers(clubId, [
				row({
					...presidentRow,
					officerPosition: "treasurer",
					currentPosition: "Club Treasurer",
				}),
			]);

			expect(await openOffices(membershipId)).toEqual([]);
			expect(stats.skippedEndedOffice).toBe(1);
		});

		it("still seeds an office on a membership that never held one", async () => {
			// The positive control, and the reason the rule is "a term was ENDED
			// here" rather than "this membership already existed": a blanket
			// refusal would pass every case above while deleting #100's seeding
			// outright, and nothing else in this file would notice.
			const clubId = await club();
			// Membership exists first, from a CSV with no office column at all.
			const membershipId = await seedFromCsv(clubId, {
				customerId: "PN-SEED",
				name: "Sam",
			});
			expect(await openOffices(membershipId)).toEqual([]);
			expect(await endedOffices(membershipId)).toEqual([]);

			const stats = await importPeopleAndMembers(clubId, [
				row({
					customerId: "PN-SEED",
					name: "Sam",
					officerPosition: "secretary",
					currentPosition: "Club Secretary",
				}),
			]);

			expect(await openOffices(membershipId)).toEqual(["secretary"]);
			expect(stats.skippedEndedOffice).toBe(0);
		});

		it("leaves an open in-app assignment alone and does not count it", async () => {
			// The pre-existing arm (#100). It is a no-op for a different reason
			// than the new one — the office is LIVE, not ended — so it must not
			// inflate the ended-office count an admin reads as "the CSV tried to
			// put somebody back in office".
			const clubId = await club();
			const membershipId = await seedFromCsv(clubId, presidentRow);
			const { reconcileOfficerTerms } = await import("./officer-terms-logic");
			await reconcileOfficerTerms(testDb, membershipId, ["secretary"]);

			const stats = await importPeopleAndMembers(clubId, [row(presidentRow)]);

			expect(await openOffices(membershipId)).toEqual(["secretary"]);
			expect(stats.skippedEndedOffice).toBe(0);
		});

		it("scopes the history read to the membership in the row", async () => {
			// `officer_terms` has no club column and this check runs per row
			// inside the import loop, so a predicate that reads the wrong
			// membership — or no membership — declines for everybody the moment
			// ONE person in the club has an ended term. That failure is silent:
			// the import still reports every row as updated.
			const clubId = await club();
			const lapsedId = await seedFromCsv(clubId, presidentRow);
			const { closeOpenOfficerTerms } = await import("./officers-logic");
			await closeOpenOfficerTerms(testDb, lapsedId);

			const stats = await importPeopleAndMembers(clubId, [
				row(presidentRow),
				row({
					customerId: "PN-NEW",
					name: "Nia",
					officerPosition: "vp_education",
					currentPosition: "Club VP Education",
				}),
			]);

			const [nia] = await testDb
				.select({ id: members.id })
				.from(members)
				.where(and(eq(members.clubId, clubId), eq(members.name, "Nia")));
			if (!nia) throw new Error("fixture: second row created no membership");

			expect(await openOffices(lapsedId)).toEqual([]);
			expect(await openOffices(nia.id)).toEqual(["vp_education"]);
			expect(stats.skippedEndedOffice).toBe(1);
		});
	},
);

/**
 * The charter dashboard (#943), DB-backed: the seeded checklist, the paid count
 * against the selected dues period, checklist editing, sponsors and club
 * mentors (linked Person or free text, never neither — in the schema AND the
 * database), the chartered club's hidden dashboard with its data kept, and the
 * two gates the server fns wrap all of it in.
 *
 * The server fns cannot be invoked from vitest, so the gates are tested two
 * ways: the guard functions against real rows here, and their wiring into each
 * fn by `charter-authz.guard.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clubCharter,
	clubCharterHelpers,
	clubCharterSteps,
	clubs,
	duesPeriods,
	memberDues,
	members,
	officerTerms,
} from "#/db/schema";
import { SEEDED_CHARTER_STEPS } from "#/lib/charter-dashboard";
import { cleanup, hasTestDb, seedClub, seedPerson, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const logic = await import("./charter-logic");
const {
	CLUB_CHARTERED_MESSAGE,
	DUES_PERIOD_NOT_IN_CLUB_MESSAGE,
	HELPER_IDENTITY_MESSAGE,
	PERSON_NOT_IN_CLUB_MESSAGE,
	REORDER_MISMATCH_MESSAGE,
	STEP_NOT_FOUND_MESSAGE,
	addCharterHelperSchema,
	getCharterDashboard,
	getCharterSummary,
} = logic;
const { requireClubAdminView, requireClubRole, NO_PERMISSION_MESSAGE } =
	await import("./guards");

const createdClubs: string[] = [];
const createdUsers: string[] = [];

afterEach(async () => {
	for (const clubId of createdClubs) await cleanup(clubId, createdUsers);
	createdClubs.length = 0;
	createdUsers.length = 0;
});

async function seedChartering() {
	const seed = await seedClub();
	createdClubs.push(seed.clubId);
	createdUsers.push(seed.adminUserId, seed.memberUserId);
	await testDb
		.update(clubs)
		.set({ charterStatus: "chartering" })
		.where(eq(clubs.id, seed.clubId));
	return seed;
}

async function markChartered(clubId: string) {
	await testDb
		.update(clubs)
		.set({
			charterStatus: "chartered",
			charteredAt: "2026-01-01",
			clubNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
		})
		.where(eq(clubs.id, clubId));
}

async function addPeriod(clubId: string, label = "Charter dues") {
	const [row] = await testDb
		.insert(duesPeriods)
		.values({ clubId, label, dueDate: new Date("2026-10-01T00:00:00Z") })
		.returning({ id: duesPeriods.id });
	if (!row) throw new Error("no period");
	return row.id;
}

/** Add `n` active members to the club; returns their membership ids. */
async function addMembers(clubId: string, n: number) {
	const ids: string[] = [];
	for (let i = 0; i < n; i++) {
		const personId = await seedPerson();
		const [m] = await testDb
			.insert(members)
			.values({ clubId, personId, name: `Charter Member ${i}` })
			.returning({ id: members.id });
		if (!m) throw new Error("no member");
		ids.push(m.id);
	}
	return ids;
}

async function stepsOf(clubId: string) {
	const d = await getCharterDashboard(clubId);
	if (!d) throw new Error("dashboard hidden");
	return d.steps;
}

describe.skipIf(!hasTestDb)("the charter dashboard (#943)", () => {
	it("seeds the common steps for a chartering club, once, even on two first visits at once", async () => {
		const seed = await seedChartering();
		await Promise.all([
			getCharterDashboard(seed.clubId),
			getCharterDashboard(seed.clubId),
		]);
		const steps = await stepsOf(seed.clubId);
		expect(steps.map((s) => s.label)).toEqual([...SEEDED_CHARTER_STEPS]);
		expect(steps.every((s) => s.doneAt === null)).toBe(true);
		const d = await getCharterDashboard(seed.clubId);
		expect(d?.membersNeeded).toBe(20);
	});

	it("counts 0 and has no period until the club picks one", async () => {
		const seed = await seedChartering();
		const d = await getCharterDashboard(seed.clubId);
		expect(d?.duesPeriodId).toBeNull();
		expect(d?.paidCount).toBe(0);
		expect(await getCharterSummary(seed.clubId)).toMatchObject({
			paidCount: 0,
			periodPicked: false,
			stepsDone: 0,
			stepsTotal: SEEDED_CHARTER_STEPS.length,
		});
	});

	it("counts the selected period's PAID members, not waived, unpaid or another period's", async () => {
		const seed = await seedChartering();
		const charterPeriod = await addPeriod(seed.clubId);
		const otherPeriod = await addPeriod(seed.clubId, "Spring renewal");
		const [a, b, c, d] = await addMembers(seed.clubId, 4);
		await testDb.insert(memberDues).values([
			{ membershipId: a!, duesPeriodId: charterPeriod, status: "paid" },
			{ membershipId: b!, duesPeriodId: charterPeriod, status: "paid" },
			{ membershipId: c!, duesPeriodId: charterPeriod, status: "waived" },
			{ membershipId: d!, duesPeriodId: otherPeriod, status: "paid" },
		]);
		await logic.updateCharterTarget({
			clubId: seed.clubId,
			membersNeeded: 12,
			duesPeriodId: charterPeriod,
		});
		const dash = await getCharterDashboard(seed.clubId);
		expect(dash?.paidCount).toBe(2);
		expect(dash?.membersNeeded).toBe(12);
		expect(dash?.periods.map((p) => p.id)).toContain(charterPeriod);

		// Deleting the picked period clears the pick rather than failing.
		await testDb.delete(duesPeriods).where(eq(duesPeriods.id, charterPeriod));
		const after = await getCharterDashboard(seed.clubId);
		expect(after?.duesPeriodId).toBeNull();
		expect(after?.paidCount).toBe(0);
	});

	it("refuses another club's dues period", async () => {
		const seed = await seedChartering();
		const other = await seedChartering();
		const foreign = await addPeriod(other.clubId);
		await expect(
			logic.updateCharterTarget({
				clubId: seed.clubId,
				membersNeeded: 20,
				duesPeriodId: foreign,
			}),
		).rejects.toThrow(DUES_PERIOD_NOT_IN_CLUB_MESSAGE);
	});

	it("bounds the target in the schema and the database", async () => {
		const seed = await seedChartering();
		expect(
			logic.updateCharterTargetSchema.safeParse({
				clubId: seed.clubId,
				membersNeeded: 0,
				duesPeriodId: null,
			}).success,
		).toBe(false);
		await getCharterDashboard(seed.clubId);
		await expect(
			testDb
				.update(clubCharter)
				.set({ membersNeeded: 0 })
				.where(eq(clubCharter.clubId, seed.clubId)),
		).rejects.toThrow();
	});

	it("edits the checklist: add, rename, mark done, un-mark, reorder, remove", async () => {
		const seed = await seedChartering();
		const clubId = seed.clubId;
		await getCharterDashboard(clubId);
		const { id: added } = await logic.addCharterStep({
			clubId,
			label: "Demo meeting held",
		});
		let steps = await stepsOf(clubId);
		expect(steps.at(-1)).toMatchObject({
			id: added,
			label: "Demo meeting held",
		});

		await logic.renameCharterStep({
			clubId,
			stepId: added,
			label: "Demo held",
		});
		await logic.setCharterStepDone({
			clubId,
			stepId: added,
			doneAt: "2026-09-01",
		});
		steps = await stepsOf(clubId);
		expect(steps.at(-1)).toMatchObject({
			label: "Demo held",
			doneAt: "2026-09-01",
		});
		expect(await getCharterSummary(clubId)).toMatchObject({ stepsDone: 1 });

		await logic.setCharterStepDone({ clubId, stepId: added, doneAt: null });
		expect((await stepsOf(clubId)).at(-1)?.doneAt).toBeNull();

		const reversed = steps.map((s) => s.id).reverse();
		await logic.reorderCharterSteps({ clubId, stepIds: reversed });
		expect((await stepsOf(clubId)).map((s) => s.id)).toEqual(reversed);

		await logic.removeCharterStep({ clubId, stepId: added });
		steps = await stepsOf(clubId);
		expect(steps.map((s) => s.id)).not.toContain(added);
		expect(steps).toHaveLength(SEEDED_CHARTER_STEPS.length);
	});

	it("refuses a reorder that is not exactly the club's steps", async () => {
		const seed = await seedChartering();
		const ids = (await stepsOf(seed.clubId)).map((s) => s.id);
		for (const stepIds of [
			ids.slice(1), // one missing
			[...ids, randomUUID()], // one extra
			[ids[0]!, ...ids.slice(0, -1)], // a duplicate standing in for one
			[...ids, ids[0]!], // every step, plus a duplicate
		]) {
			await expect(
				logic.reorderCharterSteps({ clubId: seed.clubId, stepIds }),
			).rejects.toThrow(REORDER_MISMATCH_MESSAGE);
		}
	});

	it("never edits another club's step", async () => {
		const seed = await seedChartering();
		const other = await seedChartering();
		const [theirs] = await stepsOf(other.clubId);
		await expect(
			logic.renameCharterStep({
				clubId: seed.clubId,
				stepId: theirs!.id,
				label: "Hijacked",
			}),
		).rejects.toThrow(STEP_NOT_FOUND_MESSAGE);
		await expect(
			logic.removeCharterStep({ clubId: seed.clubId, stepId: theirs!.id }),
		).rejects.toThrow(STEP_NOT_FOUND_MESSAGE);
		expect((await stepsOf(other.clubId))[0]?.label).toBe(theirs!.label);
	});

	it("refuses a done date that is not a real day or is in the future", () => {
		const base = { clubId: randomUUID(), stepId: randomUUID() };
		for (const doneAt of ["2026-02-30", "2999-01-01", "yesterday"]) {
			expect(
				logic.setCharterStepDoneSchema.safeParse({ ...base, doneAt }).success,
			).toBe(false);
		}
	});

	describe("sponsors and club mentors", () => {
		it("links a Person who is also an officer of this club, as a sponsor", async () => {
			const seed = await seedChartering();
			await testDb.insert(officerTerms).values({
				membershipId: seed.adminMemberId,
				position: "president",
			});
			const [admin] = await testDb
				.select({ personId: members.personId })
				.from(members)
				.where(eq(members.id, seed.adminMemberId));
			await logic.addCharterHelper(
				addCharterHelperSchema.parse({
					clubId: seed.clubId,
					role: "sponsor",
					personId: admin!.personId,
				}),
			);
			const d = await getCharterDashboard(seed.clubId);
			expect(d?.helpers).toHaveLength(1);
			expect(d?.helpers[0]).toMatchObject({
				role: "sponsor",
				personId: admin!.personId,
				name: "Admin User",
			});
			// The name is snapshotted, so a Person merged away leaves a named row.
			const [row] = await testDb
				.select({ name: clubCharterHelpers.name })
				.from(clubCharterHelpers)
				.where(eq(clubCharterHelpers.clubId, seed.clubId));
			expect(row?.name).toBe("Admin User");
		});

		it("records a free-text outside club mentor", async () => {
			const seed = await seedChartering();
			await logic.addCharterHelper(
				addCharterHelperSchema.parse({
					clubId: seed.clubId,
					role: "club_mentor",
					personId: null,
					name: "  Pat Mentor ",
					email: "pat@example.com",
					phone: "",
					homeClub: "Downtown Speakers",
				}),
			);
			const d = await getCharterDashboard(seed.clubId);
			expect(d?.helpers[0]).toMatchObject({
				role: "club_mentor",
				personId: null,
				name: "Pat Mentor",
				email: "pat@example.com",
				phone: null,
				homeClub: "Downtown Speakers",
			});
		});

		it("rejects a helper with neither a Person nor a name — in the schema", () => {
			const parsed = addCharterHelperSchema.safeParse({
				clubId: randomUUID(),
				role: "sponsor",
				personId: null,
				name: "   ",
			});
			expect(parsed.success).toBe(false);
			expect(parsed.error?.issues[0]?.message).toBe(HELPER_IDENTITY_MESSAGE);
		});

		it("rejects a helper with neither a Person nor a name — in the database", async () => {
			const seed = await seedChartering();
			for (const name of [null, "", "   "]) {
				await expect(
					testDb
						.insert(clubCharterHelpers)
						.values({ clubId: seed.clubId, role: "sponsor", name }),
				).rejects.toThrow();
			}
		});

		it("refuses to link a Person who is not on this club's roster", async () => {
			const seed = await seedChartering();
			const other = await seedChartering();
			await expect(
				logic.addCharterHelper(
					addCharterHelperSchema.parse({
						clubId: seed.clubId,
						role: "sponsor",
						personId: other.personId,
					}),
				),
			).rejects.toThrow(PERSON_NOT_IN_CLUB_MESSAGE);
		});

		it("removes a helper, and never another club's", async () => {
			const seed = await seedChartering();
			const other = await seedChartering();
			const { id } = await logic.addCharterHelper(
				addCharterHelperSchema.parse({
					clubId: other.clubId,
					role: "sponsor",
					name: "Theirs",
				}),
			);
			await expect(
				logic.removeCharterHelper({ clubId: seed.clubId, helperId: id }),
			).rejects.toThrow();
			await logic.removeCharterHelper({ clubId: other.clubId, helperId: id });
			expect((await getCharterDashboard(other.clubId))?.helpers).toEqual([]);
		});
	});

	describe("once chartered", () => {
		it("hides the dashboard, keeps the data, and refuses every write", async () => {
			const seed = await seedChartering();
			const clubId = seed.clubId;
			const steps = await stepsOf(clubId);
			const { id: helperId } = await logic.addCharterHelper(
				addCharterHelperSchema.parse({ clubId, role: "sponsor", name: "Kim" }),
			);
			await markChartered(clubId);

			expect(await getCharterDashboard(clubId)).toBeNull();
			expect(await getCharterSummary(clubId)).toBeNull();

			const stepId = steps[0]!.id;
			for (const write of [
				() =>
					logic.updateCharterTarget({
						clubId,
						membersNeeded: 20,
						duesPeriodId: null,
					}),
				() => logic.addCharterStep({ clubId, label: "Late" }),
				() => logic.renameCharterStep({ clubId, stepId, label: "x" }),
				() => logic.setCharterStepDone({ clubId, stepId, doneAt: null }),
				() => logic.removeCharterStep({ clubId, stepId }),
				() =>
					logic.reorderCharterSteps({
						clubId,
						stepIds: steps.map((s) => s.id),
					}),
				() =>
					logic.addCharterHelper(
						addCharterHelperSchema.parse({
							clubId,
							role: "sponsor",
							name: "Late",
						}),
					),
				() => logic.removeCharterHelper({ clubId, helperId }),
			]) {
				await expect(write()).rejects.toThrow(CLUB_CHARTERED_MESSAGE);
			}

			const keptSteps = await testDb
				.select({ id: clubCharterSteps.id })
				.from(clubCharterSteps)
				.where(eq(clubCharterSteps.clubId, clubId));
			expect(keptSteps).toHaveLength(steps.length);
			const keptHelpers = await testDb
				.select({ id: clubCharterHelpers.id })
				.from(clubCharterHelpers)
				.where(
					and(
						eq(clubCharterHelpers.clubId, clubId),
						eq(clubCharterHelpers.id, helperId),
					),
				);
			expect(keptHelpers).toHaveLength(1);
		});

		it("a club that was never chartering gets no dashboard and no seeded rows", async () => {
			const seed = await seedClub();
			createdClubs.push(seed.clubId);
			createdUsers.push(seed.adminUserId, seed.memberUserId);
			expect(await getCharterDashboard(seed.clubId)).toBeNull();
			const rows = await testDb
				.select()
				.from(clubCharter)
				.where(eq(clubCharter.clubId, seed.clubId));
			expect(rows).toEqual([]);
		});
	});

	describe("only admins (authz)", () => {
		it("a plain member is refused the write gate and the admin read gate", async () => {
			const seed = await seedChartering();
			await expect(
				requireClubRole(seed.memberUserId, seed.clubId, ["admin"]),
			).rejects.toThrow(NO_PERMISSION_MESSAGE);
			await expect(
				requireClubAdminView(seed.memberUserId, seed.clubId),
			).rejects.toThrow();
		});

		it("an admin passes both (control)", async () => {
			const seed = await seedChartering();
			await expect(
				requireClubRole(seed.adminUserId, seed.clubId, ["admin"]),
			).resolves.toBeTruthy();
			await expect(
				requireClubAdminView(seed.adminUserId, seed.clubId),
			).resolves.toBeTruthy();
		});

		it("a member-role officer with an open term passes both", async () => {
			const seed = await seedChartering();
			await testDb.insert(officerTerms).values({
				membershipId: seed.memberId,
				position: "treasurer",
			});
			await expect(
				requireClubRole(seed.memberUserId, seed.clubId, ["admin"]),
			).resolves.toBeTruthy();
			await expect(
				requireClubAdminView(seed.memberUserId, seed.clubId),
			).resolves.toBeTruthy();
		});
	});
});

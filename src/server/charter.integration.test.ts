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
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clubCharter,
	clubCharterHelpers,
	clubCharterSteps,
	clubs,
	duesPeriods,
	impersonationSessions,
	memberDues,
	members,
	officerTerms,
	people,
	user,
} from "#/db/schema";
import {
	CHARTER_HELPERS_MAX,
	CHARTER_STEPS_MAX,
	DEFAULT_MEMBERS_NEEDED,
	MEMBERS_NEEDED_MAX,
	MEMBERS_NEEDED_MIN,
	SEEDED_CHARTER_STEPS,
} from "#/lib/charter-dashboard";
import { cleanup, hasTestDb, seedClub, seedPerson, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const logic = await import("./charter-logic");
const {
	CLUB_CHARTERED_MESSAGE,
	DUES_PERIOD_NOT_IN_CLUB_MESSAGE,
	HELPERS_FULL_MESSAGE,
	HELPER_IDENTITY_MESSAGE,
	LINKED_NAME_BLANK_MESSAGE,
	PERSON_NOT_IN_CLUB_MESSAGE,
	STEPS_FULL_MESSAGE,
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
const createdSuperadmins: string[] = [];

afterEach(async () => {
	if (createdSuperadmins.length > 0) {
		await testDb
			.delete(impersonationSessions)
			.where(
				inArray(impersonationSessions.superadminUserId, createdSuperadmins),
			);
		await testDb.delete(user).where(inArray(user.id, createdSuperadmins));
		createdSuperadmins.length = 0;
	}
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

/** Rows in the three charter tables for a club. */
async function charterRowCounts(clubId: string) {
	const [charter, steps, helpers] = await Promise.all([
		testDb.select().from(clubCharter).where(eq(clubCharter.clubId, clubId)),
		testDb
			.select()
			.from(clubCharterSteps)
			.where(eq(clubCharterSteps.clubId, clubId)),
		testDb
			.select()
			.from(clubCharterHelpers)
			.where(eq(clubCharterHelpers.clubId, clubId)),
	]);
	return {
		charter: charter.length,
		steps: steps.length,
		helpers: helpers.length,
	};
}

/** The club's persisted steps: starts the checklist first (idempotent). */
async function stepsOf(clubId: string) {
	await logic.startCharterChecklist({ clubId });
	const d = await getCharterDashboard(clubId);
	if (!d) throw new Error("dashboard hidden");
	return d.steps;
}

describe.skipIf(!hasTestDb)("the charter dashboard (#943)", () => {
	it("a read writes nothing: a fresh chartering club gets the defaults, unpersisted", async () => {
		const seed = await seedChartering();
		const d = await getCharterDashboard(seed.clubId);
		const summary = await getCharterSummary(seed.clubId);
		expect(await charterRowCounts(seed.clubId)).toEqual({
			charter: 0,
			steps: 0,
			helpers: 0,
		});
		expect(d?.started).toBe(false);
		expect(d?.membersNeeded).toBe(DEFAULT_MEMBERS_NEEDED);
		expect(d?.duesPeriodId).toBeNull();
		expect(d?.steps.map((s) => s.label)).toEqual([...SEEDED_CHARTER_STEPS]);
		expect(summary).toMatchObject({
			stepsDone: 0,
			stepsTotal: SEEDED_CHARTER_STEPS.length,
		});
	});

	it("a read-only impersonator sees the defaults and is refused every write", async () => {
		const seed = await seedChartering();
		const superadminId = randomUUID();
		await testDb.insert(user).values({
			id: superadminId,
			name: "Super Admin",
			email: `super-${superadminId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		createdSuperadmins.push(superadminId);
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superadminId,
			clubId: seed.clubId,
			mode: "read_only",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		// The read gate admits them, and the read they then make writes nothing.
		await expect(
			requireClubAdminView(superadminId, seed.clubId),
		).resolves.toBeTruthy();
		expect((await getCharterDashboard(seed.clubId))?.started).toBe(false);
		// The gate every write fn runs refuses them.
		await expect(
			requireClubRole(superadminId, seed.clubId, ["admin"]),
		).rejects.toThrow();
		expect(await charterRowCounts(seed.clubId)).toEqual({
			charter: 0,
			steps: 0,
			helpers: 0,
		});
	});

	it("the first write seeds the common steps once, even two at once", async () => {
		const seed = await seedChartering();
		await Promise.all([
			logic.startCharterChecklist({ clubId: seed.clubId }),
			logic.startCharterChecklist({ clubId: seed.clubId }),
		]);
		const d = await getCharterDashboard(seed.clubId);
		expect(d?.started).toBe(true);
		expect(d?.steps.map((s) => s.label)).toEqual([...SEEDED_CHARTER_STEPS]);
		expect(d?.steps.every((s) => s.doneAt === null)).toBe(true);
		expect(d?.membersNeeded).toBe(DEFAULT_MEMBERS_NEEDED);
		expect(await charterRowCounts(seed.clubId)).toMatchObject({
			charter: 1,
			steps: SEEDED_CHARTER_STEPS.length,
		});
	});

	it("any first write seeds, not only starting the checklist", async () => {
		const seed = await seedChartering();
		await logic.addCharterStep({ clubId: seed.clubId, label: "Demo meeting" });
		const labels = (await getCharterDashboard(seed.clubId))?.steps.map(
			(s) => s.label,
		);
		expect(labels).toEqual([...SEEDED_CHARTER_STEPS, "Demo meeting"]);
	});

	it("the column default and CHECK hold the same numbers as the constants", async () => {
		const [def] = (
			await testDb.execute(sql`
				select pg_get_expr(d.adbin, d.adrelid) as expr
				from pg_attrdef d
				join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
				where d.adrelid = 'club_charter'::regclass and a.attname = 'members_needed'`)
		).rows as { expr: string }[];
		expect(Number(def?.expr)).toBe(DEFAULT_MEMBERS_NEEDED);
		const [check] = (
			await testDb.execute(sql`
				select pg_get_constraintdef(oid) as def from pg_constraint
				where conname = 'club_charter_members_needed_check'`)
		).rows as { def: string }[];
		const bounds = [...(check?.def ?? "").matchAll(/\d+/g)].map((m) =>
			Number(m[0]),
		);
		expect(bounds).toEqual([MEMBERS_NEEDED_MIN, MEMBERS_NEEDED_MAX]);
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

	it("writes only the target fields sent, so a stale tab cannot revert the other", async () => {
		const seed = await seedChartering();
		const clubId = seed.clubId;
		const period = await addPeriod(clubId);
		await logic.updateCharterTarget({
			clubId,
			membersNeeded: 12,
			duesPeriodId: period,
		});
		await logic.updateCharterTarget(
			logic.updateCharterTargetSchema.parse({ clubId, membersNeeded: 15 }),
		);
		let d = await getCharterDashboard(clubId);
		expect(d).toMatchObject({ membersNeeded: 15, duesPeriodId: period });
		await logic.updateCharterTarget(
			logic.updateCharterTargetSchema.parse({ clubId, duesPeriodId: null }),
		);
		d = await getCharterDashboard(clubId);
		expect(d).toMatchObject({ membersNeeded: 15, duesPeriodId: null });
		expect(logic.updateCharterTargetSchema.safeParse({ clubId }).success).toBe(
			false,
		);
	});

	it("caps the checklist: add refuses past the cap, reorder accepts at most it", async () => {
		const seed = await seedChartering();
		const clubId = seed.clubId;
		await logic.startCharterChecklist({ clubId });
		await testDb
			.insert(clubCharterSteps)
			.values(
				Array.from(
					{ length: CHARTER_STEPS_MAX - SEEDED_CHARTER_STEPS.length },
					(_, i) => ({ clubId, label: `Step ${i}`, position: 100 + i }),
				),
			);
		await expect(
			logic.addCharterStep({ clubId, label: "One too many" }),
		).rejects.toThrow(STEPS_FULL_MESSAGE);
		// A full checklist still reorders.
		const ids = (await stepsOf(clubId)).map((s) => s.id);
		expect(ids).toHaveLength(CHARTER_STEPS_MAX);
		await logic.reorderCharterSteps(
			logic.reorderCharterStepsSchema.parse({
				clubId,
				stepIds: [...ids].reverse(),
			}),
		);
		expect(
			logic.reorderCharterStepsSchema.safeParse({
				clubId,
				stepIds: [...ids, randomUUID()],
			}).success,
		).toBe(false);
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
		await logic.startCharterChecklist({ clubId: seed.clubId });
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

		it("shows the club's roster snapshot of a linked helper's name, not the Person's", async () => {
			const seed = await seedChartering();
			await logic.addCharterHelper(
				addCharterHelperSchema.parse({
					clubId: seed.clubId,
					role: "club_mentor",
					personId: seed.personId,
				}),
			);
			await testDb
				.update(people)
				.set({ name: "Name Another Club Wrote" })
				.where(eq(people.id, seed.personId));
			const d = await getCharterDashboard(seed.clubId);
			expect(d?.helpers[0]?.name).toBe("Member User");
		});

		it("refuses to link a roster entry whose name is blank", async () => {
			const seed = await seedChartering();
			await testDb
				.update(members)
				.set({ name: "   " })
				.where(eq(members.id, seed.memberId));
			await expect(
				logic.addCharterHelper(
					addCharterHelperSchema.parse({
						clubId: seed.clubId,
						role: "sponsor",
						personId: seed.personId,
					}),
				),
			).rejects.toThrow(LINKED_NAME_BLANK_MESSAGE);
		});

		it("survives its Person being deleted: the row keeps its name, unlinked", async () => {
			const seed = await seedChartering();
			const { id } = await logic.addCharterHelper(
				addCharterHelperSchema.parse({
					clubId: seed.clubId,
					role: "sponsor",
					personId: seed.personId,
				}),
			);
			await testDb.delete(people).where(eq(people.id, seed.personId));
			const [row] = await testDb
				.select()
				.from(clubCharterHelpers)
				.where(eq(clubCharterHelpers.id, id));
			expect(row).toMatchObject({ personId: null, name: "Member User" });
		});

		it("caps the helpers", async () => {
			const seed = await seedChartering();
			await testDb.insert(clubCharterHelpers).values(
				Array.from({ length: CHARTER_HELPERS_MAX }, (_, i) => ({
					clubId: seed.clubId,
					role: "sponsor" as const,
					name: `Helper ${i}`,
				})),
			);
			await expect(
				logic.addCharterHelper(
					addCharterHelperSchema.parse({
						clubId: seed.clubId,
						role: "sponsor",
						name: "One too many",
					}),
				),
			).rejects.toThrow(HELPERS_FULL_MESSAGE);
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

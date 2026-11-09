/**
 * DB-backed tests for `edit_role_slots` (#1542). Every write case asserts both
 * halves: what the caller is told, and what is stored.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	apiTokens,
	clubs,
	meetings,
	members,
	people,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import { MEETING_LOCKED_BLOCKING_MESSAGE } from "#/lib/assign-roles-plan";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { editRoleSlotsTool } = await import(
	"#/server/mcp/tools/edit-role-slots"
);
const { hashApiToken } = await import("#/server/api-tokens-logic");

type Blocking = { code: string; entryIndex?: number; message: string };
type Preview = {
	applied: false;
	planHash: string;
	blocking: Blocking[];
	addableRoles: { roleId: string; name: string }[];
	plan: {
		additions: {
			role: string;
			slotIndex: number;
			assignee: { memberId: string; name: string } | null;
		}[];
		removals: { slotId: string }[];
	};
};

describe.skipIf(!hasTestDb)("edit_role_slots (#1542)", () => {
	let seed: SeededClub;
	let token: string;
	const extraClubs: { clubId: string; userIds: string[] }[] = [];

	async function mintToken(userId: string): Promise<string> {
		const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
		await testDb
			.insert(apiTokens)
			.values({ userId, tokenHash: hashApiToken(raw) });
		return raw;
	}

	const call = (args: Record<string, unknown>, raw = token) =>
		editRoleSlotsTool.handler(args, { rawToken: raw });

	const preview = async (
		operations: unknown[],
		meetingId = seed.meetingId,
	): Promise<Preview> => (await call({ meetingId, operations })) as Preview;

	async function slots(meetingId = seed.meetingId) {
		return testDb
			.select({
				id: roleSlots.id,
				roleDefinitionId: roleSlots.roleDefinitionId,
				slotIndex: roleSlots.slotIndex,
				assignedMemberId: roleSlots.assignedMemberId,
				status: roleSlots.status,
			})
			.from(roleSlots)
			.where(eq(roleSlots.meetingId, meetingId))
			.orderBy(asc(roleSlots.roleDefinitionId), asc(roleSlots.slotIndex));
	}

	async function addRole(
		name: string,
		extra: Partial<typeof roleDefinitions.$inferInsert> = {},
	) {
		const [r] = await testDb
			.insert(roleDefinitions)
			.values({
				clubId: seed.clubId,
				name,
				category: "functionary",
				isSpeakerRole: false,
				...extra,
			})
			.returning({ id: roleDefinitions.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return r!.id;
	}

	async function addMember(name: string, status = "active") {
		const [p] = await testDb
			.insert(people)
			.values({ name })
			.returning({ id: people.id });
		const [m] = await testDb
			.insert(members)
			.values({
				clubId: seed.clubId,
				// biome-ignore lint/style/noNonNullAssertion: insert returns a row
				personId: p!.id,
				name,
				status: status as "active",
			})
			.returning({ id: members.id });
		// biome-ignore lint/style/noNonNullAssertion: insert returns a row
		return m!.id;
	}

	async function setStatus(status: "completed" | "cancelled") {
		await testDb
			.update(meetings)
			.set({ status })
			.where(eq(meetings.id, seed.meetingId));
	}

	beforeEach(async () => {
		seed = await seedClub();
		token = await mintToken(seed.adminUserId);
	});

	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
		for (const c of extraClubs.splice(0)) await cleanup(c.clubId, c.userIds);
	});

	describe("preview", () => {
		it("lists the new places and the assignee, writes nothing, and names the addable roles", async () => {
			const greeter = await addRole("Greeter");
			const before = await slots();
			const out = await preview([
				{ op: "add", role: "Greeter", count: 2 },
				{ op: "add", role: "timer", member: "member user" },
			]);
			expect(out.applied).toBe(false);
			expect(out.blocking).toEqual([]);
			expect(out.plan.additions.map((a) => [a.role, a.slotIndex])).toEqual([
				["Greeter", 0],
				["Greeter", 1],
				["Timer", 1],
			]);
			expect(out.plan.additions[2]?.assignee).toEqual({
				memberId: seed.memberId,
				name: "Member User",
			});
			expect(out.planHash).toMatch(/^[0-9a-f]{64}$/);
			expect(out.addableRoles.map((r) => r.name).sort()).toEqual([
				"Greeter",
				"Timer",
			]);
			expect(out.addableRoles.find((r) => r.name === "Greeter")?.roleId).toBe(
				greeter,
			);
			expect(await slots()).toEqual(before);
		});

		it("leaves a paired speaker role and a disabled role out of the addable roles", async () => {
			await addRole("Speaker", { category: "speaker", isSpeakerRole: true });
			await addRole("Retired", { enabled: false });
			const out = await preview([{ op: "add", role: "Timer" }]);
			expect(out.addableRoles.map((r) => r.name)).toEqual(["Timer"]);
		});
	});

	describe("apply", () => {
		it("creates exactly the previewed slots and seats the member", async () => {
			await addRole("Greeter");
			const ops = [
				{ op: "add", role: "Greeter", count: 2 },
				{ op: "add", role: "Timer", member: "Member User" },
			];
			const p = await preview(ops);
			const out = (await call({
				meetingId: seed.meetingId,
				operations: ops,
				planHash: p.planHash,
			})) as { applied: boolean; summary: string };
			expect(out.applied).toBe(true);
			expect(out.summary).toBe("3 places added (1 with a member)");

			const rows = await slots();
			expect(rows).toHaveLength(4);
			const timers = rows.filter(
				(r) => r.roleDefinitionId === seed.roleDefinitionId,
			);
			expect(timers.map((r) => r.slotIndex)).toEqual([0, 1]);
			const seated = timers.find((r) => r.slotIndex === 1);
			expect(seated?.assignedMemberId).toBe(seed.memberId);
			expect(seated?.status).toBe("claimed");
			expect(rows.filter((r) => r.assignedMemberId !== null)).toHaveLength(1);
		});

		it("removes an empty slot", async () => {
			const ops = [{ op: "remove", slotId: seed.slotId }];
			const p = await preview(ops);
			expect(p.plan.removals).toEqual([
				expect.objectContaining({ slotId: seed.slotId }),
			]);
			await call({
				meetingId: seed.meetingId,
				operations: ops,
				planHash: p.planHash,
			});
			expect(await slots()).toEqual([]);
		});

		it("numbers an add after a remove of the same role as the preview said", async () => {
			const ops = [
				{ op: "remove", slotId: seed.slotId },
				{ op: "add", role: "Timer" },
			];
			const p = await preview(ops);
			expect(p.plan.additions[0]?.slotIndex).toBe(0);
			await call({
				meetingId: seed.meetingId,
				operations: ops,
				planHash: p.planHash,
			});
			const rows = await slots();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.slotIndex).toBe(0);
			expect(rows[0]?.id).not.toBe(seed.slotId);
		});

		it("returns PLAN_STALE with a fresh plan when the meeting changed", async () => {
			const ops = [{ op: "add", role: "Timer" }];
			const p = await preview(ops);
			await testDb.insert(roleSlots).values({
				meetingId: seed.meetingId,
				roleDefinitionId: seed.roleDefinitionId,
				slotIndex: 1,
			});
			const err = (await call({
				meetingId: seed.meetingId,
				operations: ops,
				planHash: p.planHash,
			}).catch((e: unknown) => e)) as {
				detail: {
					planHash: string;
					plan: { additions: { slotIndex: number }[] };
				};
			};
			expect(err).toMatchObject({ code: "PLAN_STALE" });
			expect(err.detail.planHash).not.toBe(p.planHash);
			expect(err.detail.plan.additions[0]?.slotIndex).toBe(2);
			expect(await slots()).toHaveLength(2);
		});

		it("a stale hash for different operations is refused too", async () => {
			const p = await preview([{ op: "add", role: "Timer" }]);
			await expect(
				call({
					meetingId: seed.meetingId,
					operations: [{ op: "add", role: "Timer", count: 3 }],
					planHash: p.planHash,
				}),
			).rejects.toMatchObject({ code: "PLAN_STALE" });
			expect(await slots()).toHaveLength(1);
		});
	});

	describe("review round (#1562)", () => {
		/** Run `change` after authorization and before the apply transaction opens. */
		function beforeApplyTransaction(change: () => Promise<unknown>) {
			const real = testDb.transaction.bind(testDb);
			vi.spyOn(testDb, "transaction").mockImplementationOnce(
				// biome-ignore lint/suspicious/noExplicitAny: forwards the driver's own overloads untouched
				(async (...args: any[]) => {
					await change();
					return (real as (...a: unknown[]) => unknown)(...args);
				}) as typeof testDb.transaction,
			);
		}

		it("an UPPERCASE slot id removes the slot, as a lowercase one does", async () => {
			const ops = [{ op: "remove", slotId: seed.slotId.toUpperCase() }];
			const p = await preview(ops);
			expect(p.blocking).toEqual([]);
			expect(p.plan.removals).toEqual([
				expect.objectContaining({ slotId: seed.slotId }),
			]);
			await call({
				meetingId: seed.meetingId,
				operations: ops,
				planHash: p.planHash,
			});
			expect(await slots()).toEqual([]);
		});

		it("seats an ACTIVE member given by id", async () => {
			const id = await addMember("By Id Ida");
			const p = await preview([{ op: "add", role: "Timer", member: id }]);
			expect(p.blocking).toEqual([]);
			await call({
				meetingId: seed.meetingId,
				operations: [{ op: "add", role: "Timer", member: id }],
				planHash: p.planHash,
			});
			const held = (await slots()).filter((r) => r.assignedMemberId === id);
			expect(held).toHaveLength(1);
		});

		it("blocks an INACTIVE member given by id", async () => {
			const id = await addMember("Gone Id", "inactive");
			const ops = [{ op: "add", role: "Timer", member: id }];
			const p = await preview(ops);
			expect(p.blocking.map((b) => b.code)).toEqual(["NOT_A_MEMBER"]);
			await expect(
				call({
					meetingId: seed.meetingId,
					operations: ops,
					planHash: p.planHash,
				}),
			).rejects.toMatchObject({ code: "BLOCKED" });
			expect(await slots()).toHaveLength(1);
		});

		it("adds a role given by its id within the club", async () => {
			const id = await addRole("Greeter");
			const ops = [{ op: "add", role: id.toUpperCase() }];
			const p = await preview(ops);
			expect(p.blocking).toEqual([]);
			await call({
				meetingId: seed.meetingId,
				operations: ops,
				planHash: p.planHash,
			});
			expect(
				(await slots()).filter((r) => r.roleDefinitionId === id),
			).toHaveLength(1);
		});

		it("an enabled role beats a disabled role of the same name", async () => {
			await addRole("Greeter", { enabled: false });
			const live = await addRole("Greeter");
			const ops = [{ op: "add", role: "greeter" }];
			const p = await preview(ops);
			expect(p.blocking).toEqual([]);
			expect(p.plan.additions[0]).toMatchObject({ roleDefinitionId: live });
			await call({
				meetingId: seed.meetingId,
				operations: ops,
				planHash: p.planHash,
			});
			expect(
				(await slots()).filter((r) => r.roleDefinitionId === live),
			).toHaveLength(1);
		});

		it("two enabled roles with one name block, and nothing is picked", async () => {
			await addRole("Greeter");
			await addRole("Greeter");
			const ops = [{ op: "add", role: "Greeter" }];
			const p = await preview(ops);
			expect(p.blocking.map((b) => b.code)).toEqual(["ROLE_NOT_EDITABLE"]);
			await expect(
				call({
					meetingId: seed.meetingId,
					operations: ops,
					planHash: p.planHash,
				}),
			).rejects.toMatchObject({ code: "BLOCKED" });
			expect(await slots()).toHaveLength(1);
		});

		it("a matching-hash apply after the slot became held is PLAN_STALE carrying the SLOT_HELD plan", async () => {
			const ops = [{ op: "remove", slotId: seed.slotId }];
			const p = await preview(ops);
			expect(p.blocking).toEqual([]);
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId, status: "claimed" })
				.where(eq(roleSlots.id, seed.slotId));
			const err = (await call({
				meetingId: seed.meetingId,
				operations: ops,
				planHash: p.planHash,
			}).catch((e: unknown) => e)) as {
				code: string;
				detail: { plan: { blocking: { code: string }[] } };
			};
			expect(err.code).toBe("PLAN_STALE");
			expect(err.detail.plan.blocking.map((b) => b.code)).toEqual([
				"SLOT_HELD",
			]);
			expect(await slots()).toHaveLength(1);
		});

		it("accepts exactly the total-places ceiling across several adds, and refuses one more", async () => {
			const twelve = { op: "add", role: "Timer", count: 12 };
			const eight = { op: "add", role: "Timer", count: 8 };
			const p = await preview([twelve, eight]);
			expect(p.plan.additions).toHaveLength(20);
			await expect(
				call({
					meetingId: seed.meetingId,
					operations: [twelve, { op: "add", role: "Timer", count: 9 }],
				}),
			).rejects.toThrow();
			expect(await slots()).toHaveLength(1);
		});

		it("an empty preview lists the addable roles; applying the empty plan writes nothing", async () => {
			const p = await preview([]);
			expect(p.blocking).toEqual([]);
			expect(p.addableRoles.map((r) => r.name)).toEqual(["Timer"]);
			const before = await slots();
			const r = (await call({
				meetingId: seed.meetingId,
				operations: [],
				planHash: p.planHash,
			})) as { applied: boolean; summary: string };
			expect(r).toMatchObject({ applied: true, summary: "No changes" });
			expect(await slots()).toEqual(before);
		});

		it("a club archived after authorization is ARCHIVED and writes nothing", async () => {
			const ops = [{ op: "add", role: "Timer" }];
			const p = await preview(ops);
			beforeApplyTransaction(() =>
				testDb
					.update(clubs)
					.set({ archivedAt: new Date() })
					.where(eq(clubs.id, seed.clubId)),
			);
			await expect(
				call({
					meetingId: seed.meetingId,
					operations: ops,
					planHash: p.planHash,
				}),
			).rejects.toMatchObject({ code: "ARCHIVED" });
			expect(await slots()).toHaveLength(1);
		});
	});

	describe("blocking items", () => {
		/** Preview must name the code, and an apply with that hash must write nothing. */
		async function blocked(operations: unknown[], code: string) {
			const p = await preview(operations);
			expect(p.blocking.map((b) => b.code)).toContain(code);
			const before = await slots();
			await expect(
				call({
					meetingId: seed.meetingId,
					operations,
					planHash: p.planHash,
				}),
			).rejects.toMatchObject({ code: "BLOCKED" });
			expect(await slots()).toEqual(before);
			return p;
		}

		it("a role the club does not define", async () => {
			const p = await blocked(
				[{ op: "add", role: "Nonexistent" }],
				"ROLE_NOT_EDITABLE",
			);
			expect(p.blocking[0]?.entryIndex).toBe(0);
		});

		it("a role another club defines", async () => {
			const other = await seedClub();
			extraClubs.push({
				clubId: other.clubId,
				userIds: [other.adminUserId, other.memberUserId],
			});
			await blocked(
				[{ op: "add", role: other.roleDefinitionId }],
				"ROLE_NOT_EDITABLE",
			);
		});

		it("a disabled role", async () => {
			await addRole("Retired", { enabled: false });
			await blocked([{ op: "add", role: "Retired" }], "ROLE_NOT_EDITABLE");
		});

		it("a paired speaker role, to add or to remove", async () => {
			const speaker = await addRole("Speaker", {
				category: "speaker",
				isSpeakerRole: true,
			});
			await blocked([{ op: "add", role: "Speaker" }], "ROLE_NOT_EDITABLE");
			const [s] = await testDb
				.insert(roleSlots)
				.values({
					meetingId: seed.meetingId,
					roleDefinitionId: speaker,
					slotIndex: 0,
				})
				.returning({ id: roleSlots.id });
			// biome-ignore lint/style/noNonNullAssertion: insert returns a row
			await blocked([{ op: "remove", slotId: s!.id }], "ROLE_NOT_EDITABLE");
		});

		it("a held slot, with the clear-it-first reason", async () => {
			await testDb
				.update(roleSlots)
				.set({ assignedMemberId: seed.memberId, status: "claimed" })
				.where(eq(roleSlots.id, seed.slotId));
			const p = await blocked(
				[{ op: "remove", slotId: seed.slotId }],
				"SLOT_HELD",
			);
			expect(p.blocking[0]?.message).toContain("Clear it first");
			expect(await slots()).toHaveLength(1);
		});

		it("a slot that is not in this meeting", async () => {
			const other = await seedClub();
			extraClubs.push({
				clubId: other.clubId,
				userIds: [other.adminUserId, other.memberUserId],
			});
			await blocked(
				[{ op: "remove", slotId: other.slotId }],
				"SLOT_NOT_IN_MEETING",
			);
			expect(await slots(other.meetingId)).toHaveLength(1);
		});

		it("the same slot removed twice", async () => {
			await blocked(
				[
					{ op: "remove", slotId: seed.slotId },
					{ op: "remove", slotId: seed.slotId },
				],
				"DUPLICATE_SLOT",
			);
		});

		it("an inactive member, and a name nobody has", async () => {
			await addMember("Gone Gary", "inactive");
			await blocked(
				[{ op: "add", role: "Timer", member: "Gone Gary" }],
				"NOT_A_MEMBER",
			);
			await blocked(
				[{ op: "add", role: "Timer", member: "Nobody Here" }],
				"NOT_A_MEMBER",
			);
		});

		it("an ambiguous member name lists the candidates and is never guessed", async () => {
			const twin = await addMember("Member User");
			const p = await blocked(
				[{ op: "add", role: "Timer", member: "Member User" }],
				"AMBIGUOUS_MEMBER",
			);
			const item = p.blocking.find((b) => b.code === "AMBIGUOUS_MEMBER") as
				| (Blocking & {
						detail: { candidates: { memberId: string }[] };
				  })
				| undefined;
			expect(item?.detail.candidates.map((c) => c.memberId).sort()).toEqual(
				[seed.memberId, twin].sort(),
			);
			// Naming one by id resolves it.
			const ok = await preview([{ op: "add", role: "Timer", member: twin }]);
			expect(ok.blocking).toEqual([]);
			expect(ok.plan.additions[0]?.assignee?.memberId).toBe(twin);
		});

		it("a completed meeting", async () => {
			await setStatus("completed");
			const p = await blocked([{ op: "add", role: "Timer" }], "MEETING_LOCKED");
			expect(p.blocking[0]?.message).toBe(MEETING_LOCKED_BLOCKING_MESSAGE);
		});

		it("a cancelled meeting", async () => {
			await setStatus("cancelled");
			const p = await blocked([{ op: "add", role: "Timer" }], "MEETING_LOCKED");
			expect(p.blocking[0]?.message).toBe(MEETING_CANCELLED_MESSAGE);
		});

		it("one bad operation blocks the good ones too", async () => {
			await blocked(
				[
					{ op: "add", role: "Timer", count: 2 },
					{ op: "add", role: "Nonexistent" },
				],
				"ROLE_NOT_EDITABLE",
			);
			expect(await slots()).toHaveLength(1);
		});
	});

	describe("authorization and input", () => {
		it("refuses a non-admin caller", async () => {
			const memberToken = await mintToken(seed.memberUserId);
			await expect(
				call(
					{
						meetingId: seed.meetingId,
						operations: [{ op: "add", role: "Timer" }],
					},
					memberToken,
				),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(await slots()).toHaveLength(1);
		});

		it("refuses an archived club", async () => {
			await testDb
				.update(clubs)
				.set({ archivedAt: new Date() })
				.where(eq(clubs.id, seed.clubId));
			await expect(
				call({
					meetingId: seed.meetingId,
					operations: [{ op: "add", role: "Timer" }],
				}),
			).rejects.toMatchObject({ code: "ARCHIVED" });
			expect(await slots()).toHaveLength(1);
		});

		it("refuses another club's meeting", async () => {
			const other = await seedClub();
			extraClubs.push({
				clubId: other.clubId,
				userIds: [other.adminUserId, other.memberUserId],
			});
			await expect(
				call({
					meetingId: other.meetingId,
					operations: [{ op: "add", role: "Timer" }],
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(await slots(other.meetingId)).toHaveLength(1);
		});

		it("a member needs count 1", async () => {
			await expect(
				call({
					meetingId: seed.meetingId,
					operations: [
						{ op: "add", role: "Timer", count: 2, member: "Member User" },
					],
				}),
			).rejects.toThrow();
			expect(await slots()).toHaveLength(1);
		});

		it("writes an activity row for each add and remove, as the app does", async () => {
			const ops = [
				{ op: "add", role: "Timer" },
				{ op: "remove", slotId: seed.slotId },
			];
			const p = await preview(ops);
			await call({
				meetingId: seed.meetingId,
				operations: ops,
				planHash: p.planHash,
			});
			const { activityLog } = await import("#/db/schema");
			const rows = await testDb
				.select({ detail: activityLog.detail })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.targetId, seed.meetingId),
					),
				);
			expect(
				rows.map((r) => (r.detail as { change: string }).change).sort(),
			).toEqual(["role_added", "role_removed"]);
		});
	});
});

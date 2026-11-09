/**
 * DB-backed tests for `add_members` and `edit_member` (#1563): preview writes
 * nothing, the apply goes through the roster's own writers, the officer-listed
 * tools admit an admin or open-term officer and refuse a plain member, and a stale plan returns PLAN_STALE.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	apiTokens,
	clubs,
	members,
	officerTerms,
	people,
	user,
} from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { addMembersTool } = await import("#/server/mcp/tools/add-members");
const { editMemberTool } = await import("#/server/mcp/tools/edit-member");
const { hashApiToken } = await import("#/server/api-tokens-logic");
const { NOT_OFFICER_MESSAGE } = await import("#/server/mcp/authz-logic");
const membersLogic = await import("#/server/members-logic");
const { EMAIL_REFUSED_MESSAGES } = await import(
	"#/server/mcp/tools/edit-member"
);

const seeded: SeededClub[] = [];
const extraMemberIds: string[] = [];
const extraUserIds: string[] = [];
afterEach(async () => {
	if (extraMemberIds.length > 0) {
		await testDb
			.delete(officerTerms)
			.where(inArray(officerTerms.membershipId, extraMemberIds));
		await testDb
			.delete(members)
			.where(inArray(members.id, extraMemberIds.splice(0)));
	}
	for (const s of seeded.splice(0).reverse()) {
		await cleanup(s.clubId, [s.adminUserId, s.memberUserId]);
	}
	if (extraUserIds.length > 0) {
		await testDb.delete(user).where(inArray(user.id, extraUserIds.splice(0)));
	}
});

async function club(): Promise<SeededClub> {
	const s = await seedClub();
	seeded.push(s);
	return s;
}

async function tokenFor(userId: string): Promise<string> {
	const raw = `tmk_${randomUUID().replaceAll("-", "")}`;
	await testDb
		.insert(apiTokens)
		.values({ userId, tokenHash: hashApiToken(raw), name: "test" });
	return raw;
}

type Tool = typeof addMembersTool;
const run = (tool: Tool, token: string, input: Record<string, unknown>) =>
	tool.handler(input, { rawToken: token, audience: tool.audience });

async function outcome(p: Promise<unknown>) {
	try {
		return { ok: true as const, value: await p };
	} catch (e) {
		const err = e as { code?: string; message: string; detail?: unknown };
		return { ok: false as const, code: err.code, message: err.message, err };
	}
}

/** A user with an OPEN officer term and clubRole member: officer, not admin. */
async function officerToken(clubId: string): Promise<string> {
	const userId = randomUUID();
	await testDb.insert(user).values({
		id: userId,
		name: "Officer",
		email: `officer-${userId}@test.example`,
		emailVerified: true,
	});
	extraUserIds.push(userId);
	const personId = await seedPerson({
		name: "Officer Only",
		email: `officer-${userId}@test.example`,
		userId,
	});
	const [m] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name: "Officer Only",
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	if (!m) throw new Error("no member");
	extraMemberIds.push(m.id);
	await testDb.insert(officerTerms).values({
		membershipId: m.id,
		position: "vp_education",
		termStart: new Date(Date.now() - 86_400_000),
		termEnd: null,
	});
	return tokenFor(userId);
}

async function addRoster(
	clubId: string,
	opts: {
		name: string;
		preferredName?: string | null;
		email?: string | null;
		phone?: string | null;
		userId?: string | null;
		personId?: string;
	},
) {
	const personId =
		opts.personId ??
		(await seedPerson({
			name: opts.name,
			email: opts.email ?? null,
			phone: opts.phone ?? null,
			userId: opts.userId ?? null,
		}));
	const [row] = await testDb
		.insert(members)
		.values({
			clubId,
			personId,
			name: opts.name,
			preferredName: opts.preferredName ?? null,
			clubRole: "member",
			status: "active",
		})
		.returning({ id: members.id });
	if (!row) throw new Error("no member");
	extraMemberIds.push(row.id);
	return { memberId: row.id, personId };
}

async function rosterCount(clubId: string) {
	return (
		await testDb
			.select({ id: members.id })
			.from(members)
			.where(eq(members.clubId, clubId))
	).length;
}

interface AddPlan {
	plan: {
		summary: Record<string, number>;
		rows: { name: string; verdict: string; reason: string }[];
	};
	planHash: string;
}

describe.skipIf(!hasTestDb)("add_members (#1563)", () => {
	async function fixture() {
		const s = await club();
		const adminToken = await tokenFor(s.adminUserId);
		await addRoster(s.clubId, { name: "John Smith" });
		await addRoster(s.clubId, { name: "Dana Exact" });
		return { s, adminToken };
	}

	it("previews would_add / skipped / ambiguous per row and writes nothing", async () => {
		const { s, adminToken } = await fixture();
		const before = await rosterCount(s.clubId);
		const res = await run(addMembersTool, adminToken, {
			clubId: s.clubId,
			rows: [
				{ name: "Zed Newcomer" },
				{ name: "dana exact" },
				{ name: "John" },
			],
		});
		const { plan, planHash } = res as AddPlan;
		expect(planHash).toBeTruthy();
		expect(plan.rows.map((r) => r.verdict)).toEqual([
			"would_add",
			"skipped",
			"ambiguous",
		]);
		expect(plan.rows[2]?.reason).toContain("possible match for John Smith");
		expect(plan.summary).toMatchObject({
			wouldAdd: 1,
			skipped: 1,
			ambiguous: 1,
		});
		expect(await rosterCount(s.clubId)).toBe(before);
	});

	it("an ambiguous row is skipped unless listed in confirmNew", async () => {
		const { s, adminToken } = await fixture();
		const base = {
			clubId: s.clubId,
			rows: [{ name: "Zed Newcomer" }, { name: "John" }],
		};
		const p1 = (await run(addMembersTool, adminToken, base)) as AddPlan;
		const r1 = (await run(addMembersTool, adminToken, {
			...base,
			planHash: p1.planHash,
		})) as { added: number; notAdded: { name: string; verdict: string }[] };
		expect(r1.added).toBe(1);
		expect(r1.notAdded.map((r) => r.name)).toEqual(["John"]);
		const names = async () =>
			(
				await testDb
					.select({ name: members.name })
					.from(members)
					.where(eq(members.clubId, s.clubId))
			).map((m) => m.name);
		expect(await names()).toContain("Zed Newcomer");
		expect(await names()).not.toContain("John");

		const withConfirm = { ...base, confirmNew: ["john"] };
		const p2 = (await run(addMembersTool, adminToken, withConfirm)) as AddPlan;
		expect(p2.planHash).not.toBe(p1.planHash);
		// Zed is now on the roster, so only John is left.
		const r2 = (await run(addMembersTool, adminToken, {
			...withConfirm,
			planHash: p2.planHash,
		})) as { added: number };
		expect(r2.added).toBe(1);
		expect(await names()).toContain("John");
	});

	it("applies would_add rows crediting the caller with member_add, and orientation only when asked", async () => {
		const { s, adminToken } = await fixture();
		const input = { clubId: s.clubId, rows: [{ name: "Zed Newcomer" }] };
		const p = (await run(addMembersTool, adminToken, input)) as AddPlan;
		const res = (await run(addMembersTool, adminToken, {
			...input,
			planHash: p.planHash,
		})) as { added: number; addedMemberIds: string[] };
		expect(res.added).toBe(1);
		const id = res.addedMemberIds[0] as string;
		const [m] = await testDb.select().from(members).where(eq(members.id, id));
		expect(m).toMatchObject({
			name: "Zed Newcomer",
			status: "active",
			clubRole: "member",
			orientationStartedAt: null,
		});
		const log = await testDb
			.select()
			.from(activityLog)
			.where(
				and(eq(activityLog.targetId, id), eq(activityLog.action, "member_add")),
			);
		expect(log).toHaveLength(1);
		expect(log[0]?.actorMemberId).toBe(s.adminMemberId);

		const withOrientation = {
			clubId: s.clubId,
			rows: [{ name: "Yara Orient" }],
			startOrientation: true,
		};
		const p2 = (await run(
			addMembersTool,
			adminToken,
			withOrientation,
		)) as AddPlan;
		const r2 = (await run(addMembersTool, adminToken, {
			...withOrientation,
			planHash: p2.planHash,
		})) as { addedMemberIds: string[] };
		const [m2] = await testDb
			.select()
			.from(members)
			.where(eq(members.id, r2.addedMemberIds[0] as string));
		expect(m2?.orientationStartedAt).not.toBeNull();
	});

	it("a stale planHash is PLAN_STALE with a fresh plan, and writes nothing", async () => {
		const { s, adminToken } = await fixture();
		const input = { clubId: s.clubId, rows: [{ name: "Zed Newcomer" }] };
		const p = (await run(addMembersTool, adminToken, input)) as AddPlan;
		await addRoster(s.clubId, { name: "Zed Newcomer" });
		const before = await rosterCount(s.clubId);
		const out = await outcome(
			run(addMembersTool, adminToken, { ...input, planHash: p.planHash }),
		);
		expect(out).toMatchObject({ ok: false, code: "PLAN_STALE" });
		const detail = (out as { err: { detail: AddPlan } }).err.detail;
		expect(detail.plan.rows[0]?.verdict).toBe("skipped");
		expect(await rosterCount(s.clubId)).toBe(before);
	});

	it("admits an admin and an open-term officer (clubRole member), refuses a plain member", async () => {
		const { s, adminToken } = await fixture();
		const input = (name: string) => ({
			clubId: s.clubId,
			rows: [{ name }],
		});
		const applyAs = async (token: string, name: string) => {
			const p = (await run(addMembersTool, token, input(name))) as AddPlan;
			return outcome(
				run(addMembersTool, token, { ...input(name), planHash: p.planHash }),
			);
		};
		expect(await applyAs(adminToken, "Zed Newcomer")).toMatchObject({
			ok: true,
			value: { added: 1 },
		});
		expect(
			await applyAs(await officerToken(s.clubId), "Yara Officerpick"),
		).toMatchObject({ ok: true, value: { added: 1 } });
		expect(
			await outcome(
				run(
					addMembersTool,
					await tokenFor(s.memberUserId),
					input("Xavier Nope"),
				),
			),
		).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
			message: NOT_OFFICER_MESSAGE,
		});
	});

	const logCount = async (clubId: string) =>
		(
			await testDb
				.select({ id: activityLog.id })
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, clubId),
						eq(activityLog.action, "member_add"),
					),
				)
		).length;

	it("an apply where nothing lands inserts no row and logs no member_add", async () => {
		const { s, adminToken } = await fixture();
		const input = { clubId: s.clubId, rows: [{ name: "John" }] };
		const p = (await run(addMembersTool, adminToken, input)) as AddPlan;
		const before = await rosterCount(s.clubId);
		const logs = await logCount(s.clubId);
		const res = (await run(addMembersTool, adminToken, {
			...input,
			planHash: p.planHash,
		})) as { added: number; addedMemberIds: string[]; notAdded: unknown[] };
		expect(res.added).toBe(0);
		expect(res.addedMemberIds).toEqual([]);
		expect(res.notAdded).toHaveLength(1);
		expect(await rosterCount(s.clubId)).toBe(before);
		expect(await logCount(s.clubId)).toBe(logs);
	});

	it("skips a row with an invalid email, in preview and apply", async () => {
		const { s, adminToken } = await fixture();
		const input = {
			clubId: s.clubId,
			rows: [{ name: "Qux Person", email: "not-an-email" }],
		};
		const p = (await run(addMembersTool, adminToken, input)) as {
			plan: { rows: { verdict: string; skipReason: string }[] };
			planHash: string;
		};
		expect(p.plan.rows[0]).toMatchObject({
			verdict: "skipped",
			skipReason: "invalid_email",
		});
		const before = await rosterCount(s.clubId);
		const res = (await run(addMembersTool, adminToken, {
			...input,
			planHash: p.planHash,
		})) as { added: number };
		expect(res.added).toBe(0);
		expect(await rosterCount(s.clubId)).toBe(before);
	});

	it("marks a row sharing a whole name word with a member ambiguous (Jon vs John Smith)", async () => {
		const { s, adminToken } = await fixture();
		const out = (await run(addMembersTool, adminToken, {
			clubId: s.clubId,
			rows: [{ name: "Jon Smith" }, { name: "Zed Newcomer" }],
		})) as AddPlan & {
			plan: {
				rows: { verdict: string; possibleMatches: { name: string }[] }[];
			};
		};
		expect(out.plan.rows.map((r) => r.verdict)).toEqual([
			"ambiguous",
			"would_add",
		]);
		expect(out.plan.rows[0]?.possibleMatches.map((m) => m.name)).toEqual([
			"John Smith",
		]);
	});

	it("an old planHash with confirmNew added is PLAN_STALE, and the message names confirmNew", async () => {
		const { s, adminToken } = await fixture();
		const input = { clubId: s.clubId, rows: [{ name: "John" }] };
		const p = (await run(addMembersTool, adminToken, input)) as AddPlan;
		expect(p.plan.rows[0]?.reason).toContain("PREVIEW AGAIN");
		const out = await outcome(
			run(addMembersTool, adminToken, {
				...input,
				confirmNew: ["John"],
				planHash: p.planHash,
			}),
		);
		expect(out).toMatchObject({ ok: false, code: "PLAN_STALE" });
		expect((out as { message: string }).message).toContain("confirmNew");
		expect(addMembersTool.config.description).toContain("PREVIEW AGAIN");
	});

	it("previews the phone as it will be stored, and a changed club country code makes the hash stale", async () => {
		const { s, adminToken } = await fixture();
		const input = {
			clubId: s.clubId,
			rows: [{ name: "Zed Newcomer", phone: "(555) 000-3333" }],
		};
		const p = (await run(addMembersTool, adminToken, input)) as AddPlan & {
			plan: { rows: { phone: string }[] };
		};
		expect(p.plan.rows[0]?.phone).toBe("+15550003333");
		await testDb
			.update(clubs)
			.set({ defaultCountryCode: "+44" })
			.where(eq(clubs.id, s.clubId));
		const out = await outcome(
			run(addMembersTool, adminToken, { ...input, planHash: p.planHash }),
		);
		expect(out).toMatchObject({ ok: false, code: "PLAN_STALE" });
		expect(
			(out as { err: { detail: { plan: { rows: { phone: string }[] } } } }).err
				.detail.plan.rows[0]?.phone,
		).not.toBe("+15550003333");
	});

	it("reports a planned row the writer did not insert as skippedAtWrite", async () => {
		const { s, adminToken } = await fixture();
		const input = { clubId: s.clubId, rows: [{ name: "Zed Newcomer" }] };
		const p = (await run(addMembersTool, adminToken, input)) as AddPlan;
		const spy = vi.spyOn(membersLogic, "applyBulkImport").mockResolvedValue({
			insertedIds: [],
			inserted: 0,
			skipped: 1,
			skippedOfficerAssignments: 0,
		});
		try {
			const res = (await run(addMembersTool, adminToken, {
				...input,
				planHash: p.planHash,
			})) as {
				added: number;
				skippedAtWrite: number;
				skippedAtWriteNote: string;
			};
			expect(res.added).toBe(0);
			expect(res.skippedAtWrite).toBe(1);
			expect(res.skippedAtWriteNote).toContain("duplicates");
		} finally {
			spy.mockRestore();
		}
	});
});

interface EditPlan {
	plan: {
		changes: { field: string; before: string | null; after: string | null }[];
		emailRefusal: { code: string; message: string } | null;
	};
	planHash: string;
}

describe.skipIf(!hasTestDb)("edit_member (#1563)", () => {
	async function fixture() {
		const s = await club();
		const adminToken = await tokenFor(s.adminUserId);
		const target = await addRoster(s.clubId, {
			name: "Robert Roe",
			preferredName: "Bob",
			email: "robert@example.test",
			phone: "+15550001111",
		});
		return { s, adminToken, target };
	}
	const personOf = async (id: string) =>
		(await testDb.select().from(people).where(eq(people.id, id)))[0];
	const memberOf = async (id: string) =>
		(await testDb.select().from(members).where(eq(members.id, id)))[0];

	it("previews before -> after and writes nothing", async () => {
		const { s, adminToken, target } = await fixture();
		const out = (await run(editMemberTool, adminToken, {
			clubId: s.clubId,
			memberId: target.memberId,
			name: "Robert Rowe",
			phone: "5550002222",
		})) as EditPlan;
		expect(out.plan.changes.map((c) => [c.field, c.before])).toEqual([
			["name", "Robert Roe"],
			["phone", "+15550001111"],
		]);
		expect((await memberOf(target.memberId))?.name).toBe("Robert Roe");
	});

	it("a name-only edit leaves preferredName, email and phone unchanged", async () => {
		const { s, adminToken, target } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: target.memberId,
			name: "Robert Rowe",
		};
		const p = (await run(editMemberTool, adminToken, input)) as EditPlan;
		await run(editMemberTool, adminToken, { ...input, planHash: p.planHash });
		const m = await memberOf(target.memberId);
		expect(m).toMatchObject({ name: "Robert Rowe", preferredName: "Bob" });
		expect(await personOf(target.personId)).toMatchObject({
			email: "robert@example.test",
			phone: "+15550001111",
		});
		const log = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, target.memberId),
					eq(activityLog.action, "member_edit"),
				),
			);
		expect(log).toHaveLength(1);
		expect(log[0]?.actorMemberId).toBe(s.adminMemberId);
	});

	it("an explicit null clears preferredName", async () => {
		const { s, adminToken, target } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: target.memberId,
			preferredName: null,
		};
		const p = (await run(editMemberTool, adminToken, input)) as EditPlan;
		await run(editMemberTool, adminToken, { ...input, planHash: p.planHash });
		expect((await memberOf(target.memberId))?.preferredName).toBeNull();
	});

	it("writes a changed email on a free person", async () => {
		const { s, adminToken, target } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: target.memberId,
			email: "new@example.test",
		};
		const p = (await run(editMemberTool, adminToken, input)) as EditPlan;
		expect(p.plan.emailRefusal).toBeNull();
		await run(editMemberTool, adminToken, { ...input, planHash: p.planHash });
		expect((await personOf(target.personId))?.email).toBe("new@example.test");
	});

	it("refuses the email on a signed-in person in preview and apply, and the rest still saves", async () => {
		const s = await club();
		const adminToken = await tokenFor(s.adminUserId);
		const userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Bound",
			email: `bound-${userId}@test.example`,
			emailVerified: true,
		});
		extraUserIds.push(userId);
		const target = await addRoster(s.clubId, {
			name: "Bea Bound",
			email: "bea@example.test",
			userId,
		});
		const input = {
			clubId: s.clubId,
			memberId: target.memberId,
			name: "Bea Bound-Jones",
			email: "other@example.test",
		};
		const p = (await run(editMemberTool, adminToken, input)) as EditPlan;
		expect(p.plan.emailRefusal).toEqual({
			code: "bound",
			message: EMAIL_REFUSED_MESSAGES.bound,
		});
		const res = (await run(editMemberTool, adminToken, {
			...input,
			planHash: p.planHash,
		})) as {
			emailRefused: { code: string } | null;
			changed: { field: string }[];
		};
		expect(res.emailRefused?.code).toBe("bound");
		expect(res.changed.map((c) => c.field)).toEqual(["name"]);
		expect((await memberOf(target.memberId))?.name).toBe("Bea Bound-Jones");
		expect((await personOf(target.personId))?.email).toBe("bea@example.test");
	});

	it("refuses the email on a person another club also holds, and the rest still saves", async () => {
		const { s, adminToken, target } = await fixture();
		const other = await club();
		await addRoster(other.clubId, {
			name: "Robert Roe",
			personId: target.personId,
		});
		const input = {
			clubId: s.clubId,
			memberId: target.memberId,
			name: "Robert Rowe",
			email: "new@example.test",
		};
		const p = (await run(editMemberTool, adminToken, input)) as EditPlan;
		expect(p.plan.emailRefusal?.code).toBe("multi_club");
		const res = (await run(editMemberTool, adminToken, {
			...input,
			planHash: p.planHash,
		})) as { emailRefused: { code: string } | null };
		expect(res.emailRefused?.code).toBe("multi_club");
		expect((await memberOf(target.memberId))?.name).toBe("Robert Rowe");
		expect((await personOf(target.personId))?.email).toBe(
			"robert@example.test",
		);
	});

	it("a stale planHash is PLAN_STALE with a fresh plan, and writes nothing", async () => {
		const { s, adminToken, target } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: target.memberId,
			name: "Robert Rowe",
		};
		const p = (await run(editMemberTool, adminToken, input)) as EditPlan;
		await testDb
			.update(members)
			.set({ name: "Somebody Else" })
			.where(eq(members.id, target.memberId));
		const out = await outcome(
			run(editMemberTool, adminToken, { ...input, planHash: p.planHash }),
		);
		expect(out).toMatchObject({ ok: false, code: "PLAN_STALE" });
		expect((await memberOf(target.memberId))?.name).toBe("Somebody Else");
	});

	it("an unknown member is NOT_FOUND and an empty edit is VALIDATION", async () => {
		const { s, adminToken, target } = await fixture();
		expect(
			await outcome(
				run(editMemberTool, adminToken, {
					clubId: s.clubId,
					memberId: randomUUID(),
					name: "X",
				}),
			),
		).toMatchObject({ ok: false, code: "NOT_FOUND" });
		expect(
			await outcome(
				run(editMemberTool, adminToken, {
					clubId: s.clubId,
					memberId: target.memberId,
				}),
			),
		).toMatchObject({ ok: false, code: "VALIDATION" });
	});

	it("admits an admin and an open-term officer (clubRole member), refuses a plain member", async () => {
		const { s, adminToken, target } = await fixture();
		const input = (name: string) => ({
			clubId: s.clubId,
			memberId: target.memberId,
			name,
		});
		const applyAs = async (token: string, name: string) => {
			const p = (await run(editMemberTool, token, input(name))) as EditPlan;
			return outcome(
				run(editMemberTool, token, { ...input(name), planHash: p.planHash }),
			);
		};
		expect(await applyAs(adminToken, "Robert Rowe")).toMatchObject({
			ok: true,
		});
		expect(
			await applyAs(await officerToken(s.clubId), "Robert Row"),
		).toMatchObject({ ok: true });
		expect((await memberOf(target.memberId))?.name).toBe("Robert Row");
		expect(
			await outcome(
				run(editMemberTool, await tokenFor(s.memberUserId), input("Nope")),
			),
		).toMatchObject({
			ok: false,
			code: "FORBIDDEN",
			message: NOT_OFFICER_MESSAGE,
		});
	});

	it("a malformed email is VALIDATION in preview and apply, and nothing is written", async () => {
		const { s, adminToken, target } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: target.memberId,
			name: "Robert Rowe",
			email: "not-an-email",
		};
		expect(await outcome(run(editMemberTool, adminToken, input))).toMatchObject(
			{ ok: false, code: "VALIDATION" },
		);
		expect(
			await outcome(
				run(editMemberTool, adminToken, { ...input, planHash: "x" }),
			),
		).toMatchObject({ ok: false, code: "VALIDATION" });
		expect((await memberOf(target.memberId))?.name).toBe("Robert Roe");
		expect((await personOf(target.personId))?.email).toBe(
			"robert@example.test",
		);
	});

	it("a case-only email change is not a change for a signed-in person, but is for a free one", async () => {
		const s = await club();
		const adminToken = await tokenFor(s.adminUserId);
		const userId = randomUUID();
		await testDb.insert(user).values({
			id: userId,
			name: "Bound",
			email: `bound-${userId}@test.example`,
			emailVerified: true,
		});
		extraUserIds.push(userId);
		const bound = await addRoster(s.clubId, {
			name: "Bea Bound",
			email: "bea@example.test",
			userId,
		});
		const free = await addRoster(s.clubId, {
			name: "Fred Free",
			email: "fred@example.test",
		});
		const boundPlan = (await run(editMemberTool, adminToken, {
			clubId: s.clubId,
			memberId: bound.memberId,
			email: " BEA@Example.test ",
		})) as EditPlan;
		expect(boundPlan.plan.changes).toEqual([]);
		expect(boundPlan.plan.emailRefusal).toBeNull();
		const freeInput = {
			clubId: s.clubId,
			memberId: free.memberId,
			email: "Fred@Example.test",
		};
		const freePlan = (await run(
			editMemberTool,
			adminToken,
			freeInput,
		)) as EditPlan;
		expect(freePlan.plan.changes.map((c) => c.field)).toEqual(["email"]);
		await run(editMemberTool, adminToken, {
			...freeInput,
			planHash: freePlan.planHash,
		});
		expect((await personOf(free.personId))?.email).toBe("Fred@Example.test");
	});

	it("an apply with no changes writes nothing and logs no member_edit", async () => {
		const { s, adminToken, target } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: target.memberId,
			name: "Robert Roe",
		};
		const p = (await run(editMemberTool, adminToken, input)) as EditPlan;
		expect(p.plan.changes).toEqual([]);
		const res = (await run(editMemberTool, adminToken, {
			...input,
			planHash: p.planHash,
		})) as { applied: boolean; changed: unknown[] };
		expect(res).toMatchObject({ applied: true, changed: [] });
		const log = await testDb
			.select()
			.from(activityLog)
			.where(
				and(
					eq(activityLog.targetId, target.memberId),
					eq(activityLog.action, "member_edit"),
				),
			);
		expect(log).toHaveLength(0);
	});

	it("blank strings clear preferredName, email and phone", async () => {
		const { s, adminToken, target } = await fixture();
		const input = {
			clubId: s.clubId,
			memberId: target.memberId,
			preferredName: "",
			email: "",
			phone: "",
		};
		const p = (await run(editMemberTool, adminToken, input)) as EditPlan;
		expect(p.plan.changes.map((c) => [c.field, c.after])).toEqual([
			["preferredName", null],
			["email", null],
			["phone", null],
		]);
		await run(editMemberTool, adminToken, { ...input, planHash: p.planHash });
		expect((await memberOf(target.memberId))?.preferredName).toBeNull();
		expect(await personOf(target.personId)).toMatchObject({
			email: null,
			phone: null,
		});
	});
});

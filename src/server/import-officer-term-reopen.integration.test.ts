import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, members, officerTerms, people } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Guard decisions are real; only the request/session boundary is replaced.
vi.mock("@tanstack/react-start/server", () => ({
	getRequest: () => {
		throw new Error("no request");
	},
}));

const csv = (rows: string[]) =>
	`Customer ID,Name,Email,Status (*),Current Position\n${rows.join("\n")}\n`;

describe.skipIf(!hasTestDb)("explicit CSV officer approval", () => {
	let seed: SeededClub;
	let text: string;
	let logic: typeof import("./upload-members-logic");
	beforeEach(async () => {
		seed = await seedClub();
		logic = await import("./upload-members-logic");
		text = csv([
			`,Member User,member-${seed.memberUserId}@test.example,PaidMember,Club President`,
		]);
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});
	const offices = async (id: string) =>
		testDb
			.select()
			.from(officerTerms)
			.where(
				and(eq(officerTerms.membershipId, id), isNull(officerTerms.termEnd)),
			);
	const preview = () =>
		logic.previewMemberImport(seed.clubId, text, seed.adminUserId);
	const commit = (
		officerApprovals: string[] = [],
		csvText = text,
		userId = seed.adminUserId,
	) =>
		logic.commitMemberImport(seed.clubId, csvText, {
			userId,
			officerApprovals,
		});

	it("imports new and existing roster rows without granting any offices by default", async () => {
		text = csv([
			`,Member User,member-${seed.memberUserId}@test.example,PaidMember,Club President`,
			`${randomUUID()},New,${randomUUID()}@test.example,PaidMember,Club Secretary`,
		]);
		const result = await commit();
		expect(result.stats.membersCreated).toBe(1);
		expect(result.stats.membersUpdated).toBe(1);
		expect(result.stats.skippedOfficerAssignments).toBe(2);
		expect(await offices(seed.memberId)).toEqual([]);
		const all = await testDb
			.select()
			.from(officerTerms)
			.innerJoin(members, eq(members.id, officerTerms.membershipId))
			.where(eq(members.clubId, seed.clubId));
		expect(all).toEqual([]);
	});

	it("grants only an explicitly selected proposal with its real actor and audit", async () => {
		const p = await preview();
		expect(p.officerAccessChanges).toHaveLength(1);
		expect(p.officerAccessChanges[0]).toMatchObject({
			name: "Member User",
			position: "president",
		});
		expect(await offices(seed.memberId)).toEqual([]);
		const result = await commit([p.officerAccessChanges[0].approval]);
		expect(result.officerGrants).toBe(1);
		expect((await offices(seed.memberId))[0].termStart).not.toBeNull();
		const logs = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.clubId, seed.clubId));
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatchObject({
			actorMemberId: seed.adminMemberId,
			action: "member_edit",
			targetId: seed.memberId,
			detail: {
				source: "csv_officer_approval",
				approvedBy: seed.adminUserId,
				officersAdded: ["president"],
			},
		});
	});

	it("allows a returning officer after fresh approval and retains ended history", async () => {
		const { reconcileOfficerTerms } = await import("./officer-terms-logic");
		await reconcileOfficerTerms(testDb, seed.memberId, ["president"]);
		await reconcileOfficerTerms(testDb, seed.memberId, []);
		const p = await preview();
		expect(
			(await commit([p.officerAccessChanges[0].approval])).officerGrants,
		).toBe(1);
		const terms = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId));
		expect(terms).toHaveLength(2);
		expect(terms.filter((t) => t.termEnd !== null)).toHaveLength(1);
	});

	it.each([
		"tampered",
		"csv",
		"user",
		"club",
	])("ignores %s approvals while importing the roster", async (kind) => {
		const p = await preview();
		let token = p.officerAccessChanges[0].approval;
		if (kind === "tampered") token = `${token.slice(0, -5)}xxxxx`;
		if (kind === "row" || kind === "state") {
			const [payload, signature] = token.split(".");
			const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
			if (kind === "row") forged.rowIndex = 1;
			else forged.state = "client-permission-snapshot";
			token = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;
		}
		if (kind === "padded") token += "=";
		if (kind === "club") {
			const other = await seedClub();
			try {
				token = (
					await logic.previewMemberImport(other.clubId, text, other.adminUserId)
				).officerAccessChanges[0].approval;
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		}
		if (kind === "user") {
			await testDb
				.update(members)
				.set({ clubRole: "admin" })
				.where(eq(members.id, seed.memberId));
			token = (
				await logic.previewMemberImport(seed.clubId, text, seed.memberUserId)
			).officerAccessChanges[0].approval;
		}
		const result = await commit([token], kind === "csv" ? `${text}\n` : text);
		expect(result.stats.membersUpdated).toBe(1);
		expect(result.officerGrants).toBe(0);
		expect(result.officerRefreshRequired).toHaveLength(1);
		expect(await offices(seed.memberId)).toEqual([]);
	});

	it("skips stale revocations while retaining unaffected selected grants", async () => {
		text = csv([
			`,Member User,member-${seed.memberUserId}@test.example,PaidMember,Club President`,
			`${randomUUID()},New,${randomUUID()}@test.example,PaidMember,Club Secretary`,
		]);
		const p = await preview();
		const { reconcileOfficerTerms } = await import("./officer-terms-logic");
		await reconcileOfficerTerms(testDb, seed.memberId, ["treasurer"]);
		await reconcileOfficerTerms(testDb, seed.memberId, []);
		const result = await commit(p.officerAccessChanges.map((x) => x.approval));
		expect(result.officerGrants).toBe(1);
		expect(result.officerRefreshRequired).toHaveLength(1);
		expect(result.stats.membersCreated).toBe(1);
		expect(await offices(seed.memberId)).toEqual([]);
	});

	it("detects revoked then reinstated membership access even when values return to their preview state", async () => {
		const p = await preview();
		await testDb
			.update(members)
			.set({ status: "inactive" })
			.where(eq(members.id, seed.memberId));
		await testDb
			.update(members)
			.set({ status: "active" })
			.where(eq(members.id, seed.memberId));
		expect(
			(await commit(p.officerAccessChanges.map((x) => x.approval)))
				.officerRefreshRequired,
		).toHaveLength(1);
		expect(await offices(seed.memberId)).toEqual([]);
	});

	it("includes duplicate Persons and their memberships in access revalidation", async () => {
		const duplicate = await seedPerson({
			name: "Duplicate",
			userId: seed.memberUserId,
		});
		const [m] = await testDb
			.insert(members)
			.values({ clubId: seed.clubId, personId: duplicate, name: "Duplicate" })
			.returning();
		const p = await preview();
		const { reconcileOfficerTerms } = await import("./officer-terms-logic");
		await reconcileOfficerTerms(testDb, m.id, ["treasurer"]);
		await reconcileOfficerTerms(testDb, m.id, []);
		expect(
			(await commit(p.officerAccessChanges.map((x) => x.approval)))
				.officerRefreshRequired,
		).toHaveLength(1);
		expect(await offices(seed.memberId)).toEqual([]);
	});

	it("does not overwrite an existing office or revoke offices omitted from CSV", async () => {
		const { reconcileOfficerTerms } = await import("./officer-terms-logic");
		await reconcileOfficerTerms(testDb, seed.memberId, ["secretary"]);
		expect((await preview()).officerAccessChanges).toEqual([]);
		await commit();
		await commit([], text.replace("Club President", ""));
		expect((await offices(seed.memberId)).map((t) => t.position)).toEqual([
			"secretary",
		]);
	});
	it("binds a new no-email person's approval to one actual grant (no replay)", async () => {
		text = csv([",First-time Officer,,PaidMember,Club Secretary"]);
		const p = await preview();
		const token = p.officerAccessChanges[0].approval;
		expect((await commit([token])).officerGrants).toBe(1);
		const replay = await commit([token]);
		expect(replay.officerGrants).toBe(0);
		expect(replay.officerRefreshRequired).toHaveLength(1);
	});

	it("skips approval when identity binding changes", async () => {
		const p = await preview();
		await testDb
			.update(people)
			.set({ userId: null })
			.where(eq(people.id, seed.personId));
		expect(
			(await commit(p.officerAccessChanges.map((x) => x.approval)))
				.officerRefreshRequired,
		).toHaveLength(1);
		expect(await offices(seed.memberId)).toEqual([]);
	});

	it("skips approval when a duplicate membership appears after preview", async () => {
		const p = await preview();
		const duplicate = await seedPerson({
			name: "New duplicate",
			userId: seed.memberUserId,
		});
		await testDb.insert(members).values({
			personId: duplicate,
			clubId: seed.clubId,
			name: "New duplicate",
		});
		expect(
			(await commit(p.officerAccessChanges.map((x) => x.approval)))
				.officerRefreshRequired,
		).toHaveLength(1);
		expect(await offices(seed.memberId)).toEqual([]);
	});

	it("skips expired approvals while importing the roster", async () => {
		const p = await preview();
		const clock = vi
			.spyOn(Date, "now")
			.mockReturnValue(Date.now() + 16 * 60 * 1000);
		try {
			const result = await commit(
				p.officerAccessChanges.map((x) => x.approval),
			);
			expect(result.officerGrants).toBe(0);
			expect(result.officerRefreshRequired).toHaveLength(1);
			expect(result.stats.membersUpdated).toBe(1);
		} finally {
			clock.mockRestore();
		}
	});

	it("rolls back the grant when its activity write fails", async () => {
		const p = await preview();
		const activity = await import("./activity");
		const log = vi
			.spyOn(activity, "logActivity")
			.mockRejectedValueOnce(new Error("audit unavailable"));
		try {
			await expect(
				commit(p.officerAccessChanges.map((x) => x.approval)),
			).rejects.toThrow("audit unavailable");
		} finally {
			log.mockRestore();
		}
		expect(await offices(seed.memberId)).toEqual([]);
		expect(
			await testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.clubId, seed.clubId)),
		).toEqual([]);
	});

	it("imports roster but skips grants when a competing officer writer holds the table", async () => {
		const p = await preview();
		const { openBlockingTx } = await import("#/test/db");
		const { reconcileOfficerTerms } = await import("./officer-terms-logic");
		const blocker = await openBlockingTx(async (tx) => {
			await reconcileOfficerTerms(tx, seed.memberId, ["treasurer"]);
			await reconcileOfficerTerms(tx, seed.memberId, []);
		});
		try {
			const result = await commit(
				p.officerAccessChanges.map((x) => x.approval),
			);
			expect(result.stats.membersUpdated).toBe(1);
			expect(result.officerGrants).toBe(0);
			expect(result.officerRefreshRequired.join(" ")).toMatch(
				/refresh preview/i,
			);
		} finally {
			await blocker.commit();
		}
		expect(await offices(seed.memberId)).toEqual([]);
	});
	it("serializes a member-edit revocation behind an approved grant and its audit", async () => {
		const p = await preview();
		const { sql } = await import("drizzle-orm");
		const { waitForLockWait } = await import("#/test/db");
		const activity = await import("./activity");
		const original = activity.logActivity;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let ready!: (pid: number) => void;
		const holding = new Promise<number>((resolve) => {
			ready = resolve;
		});
		const log = vi
			.spyOn(activity, "logActivity")
			.mockImplementationOnce(async (conn, input) => {
				const result = await conn.execute(sql`select pg_backend_pid() as pid`);
				ready(Number((result.rows[0] as { pid: number }).pid));
				await gate;
				await original(conn, input);
			});
		const applying = commit(p.officerAccessChanges.map((x) => x.approval));
		applying.catch(() => {});
		let editing: Promise<unknown> | undefined;
		try {
			const pid = await holding;
			const { applyMemberEdit } = await import("./members-logic");
			editing = applyMemberEdit({
				clubId: seed.clubId,
				memberId: seed.memberId,
				actorMemberId: seed.adminMemberId,
				name: "Member User",
				email: `member-${seed.memberUserId}@test.example`,
				phone: null,
				officerPositions: [],
			});
			editing.catch(() => {});
			await waitForLockWait('update "members"', pid);
		} finally {
			release();
			log.mockRestore();
		}
		expect((await applying).officerGrants).toBe(1);
		await editing;
		expect(await offices(seed.memberId)).toEqual([]);
		const history = await testDb
			.select()
			.from(officerTerms)
			.where(eq(officerTerms.membershipId, seed.memberId));
		expect(history).toHaveLength(1);
		expect(history[0].termEnd).not.toBeNull();
	});
	it("detects a closed term revoked and reinstated back to identical values", async () => {
		const end = new Date("2026-01-01T00:00:00Z");
		const [term] = await testDb
			.insert(officerTerms)
			.values({
				membershipId: seed.memberId,
				position: "president",
				termEnd: end,
			})
			.returning();
		const p = await preview();
		await testDb
			.update(officerTerms)
			.set({ termEnd: null })
			.where(eq(officerTerms.id, term.id));
		await testDb
			.update(officerTerms)
			.set({ termEnd: end })
			.where(eq(officerTerms.id, term.id));
		expect(
			(await commit(p.officerAccessChanges.map((x) => x.approval)))
				.officerRefreshRequired,
		).toHaveLength(1);
		expect(await offices(seed.memberId)).toEqual([]);
	});

	it("skips a grant if a previously new row now resolves to an existing person", async () => {
		const customerId = randomUUID();
		text = csv([`${customerId},First-time,,PaidMember,Club President`]);
		const p = await preview();
		const personId = await seedPerson({ name: "Resolved later", customerId });
		try {
			const result = await commit(
				p.officerAccessChanges.map((x) => x.approval),
			);
			expect(result.stats.membersCreated).toBe(1);
			expect(result.officerGrants).toBe(0);
			expect(result.officerRefreshRequired).toHaveLength(1);
		} finally {
			await testDb.delete(people).where(eq(people.id, personId));
		}
	});
	it("requires fresh approval after the approving admin was demoted and reinstated", async () => {
		const p = await preview();
		await testDb
			.update(members)
			.set({ clubRole: "member" })
			.where(eq(members.id, seed.adminMemberId));
		await testDb
			.update(members)
			.set({ clubRole: "admin" })
			.where(eq(members.id, seed.adminMemberId));
		expect(
			(await commit(p.officerAccessChanges.map((x) => x.approval)))
				.officerRefreshRequired,
		).toHaveLength(1);
		expect(await offices(seed.memberId)).toEqual([]);
	});
});

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, members, officerTerms, people, user } from "#/db/schema";
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

	// Pause at the audit inside the real grant transaction, after scoped locks.
	const holdGrant = async (tokens: string[], actor = seed.adminUserId) => {
		const { sql } = await import("drizzle-orm");
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
		const applying = commit(tokens, text, actor);
		try {
			const pid = await Promise.race([
				holding,
				applying.then(() => {
					throw new Error("Grant did not reach audit");
				}),
			]);
			return {
				applying,
				pid,
				release: () => {
					release();
					log.mockRestore();
				},
			};
		} catch (error) {
			release();
			log.mockRestore();
			throw error;
		}
	};

	it("allows unrelated-club member writes to finish while an approved grant is held", async () => {
		const other = await seedClub();
		const p = await preview();
		const held = await holdGrant(p.officerAccessChanges.map((x) => x.approval));
		try {
			const { applyMemberEdit } = await import("./members-logic");
			const editing = applyMemberEdit({
				clubId: other.clubId,
				memberId: other.memberId,
				actorMemberId: other.adminMemberId,
				name: "Unrelated edit",
				email: null,
				phone: null,
				officerPositions: [],
			});
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					editing,
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(
							() => reject(new Error("Unrelated edit blocked by grant")),
							5000,
						);
					}),
				]);
			} finally {
				clearTimeout(timeout);
			}

			const [row] = await testDb
				.select()
				.from(members)
				.where(eq(members.id, other.memberId));
			expect(row.name).toBe("Unrelated edit");
		} finally {
			held.release();
			await held.applying;
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
		expect(await offices(seed.memberId)).toHaveLength(1);
	});

	it("serializes club archive through grant and audit, and rejects archive/unarchive ABA", async () => {
		const { archiveClub, unarchiveClub } = await import("./onboarding-logic");
		const { waitForLockWait } = await import("#/test/db");
		const p = await preview();
		const held = await holdGrant(p.officerAccessChanges.map((x) => x.approval));
		const archiving = archiveClub(seed.clubId);
		try {
			await waitForLockWait('update "clubs"', held.pid);
		} finally {
			held.release();
		}
		expect((await held.applying).officerGrants).toBe(1);
		await archiving;
		await unarchiveClub(seed.clubId);
		const { reconcileOfficerTerms } = await import("./officer-terms-logic");
		await reconcileOfficerTerms(testDb, seed.memberId, []);
		const fresh = await preview();
		await archiveClub(seed.clubId);
		await unarchiveClub(seed.clubId);
		const result = await commit(
			fresh.officerAccessChanges.map((x) => x.approval),
		);
		expect(result.stats.membersUpdated).toBe(1);
		expect(result.officerGrants).toBe(0);
		expect(result.officerRefreshRequired).toHaveLength(1);
	});

	it.each([
		"session",
		"superadmin",
	] as const)("serializes %s revocation and rejects approvals after revocation", async (kind) => {
		const other = await seedClub();
		const actor = other.adminUserId;
		const { startImpersonation, endImpersonation } = await import(
			"./impersonation-logic"
		);
		const { reconcileSuperadminFlag } = await import("#/lib/superadmin");
		const { waitForLockWait } = await import("#/test/db");
		await testDb
			.update(user)
			.set({ isSuperadmin: true })
			.where(eq(user.id, actor));
		await startImpersonation(actor, {
			clubId: seed.clubId,
			mode: "read_write",
			reason: "Test approval",
		});
		const p = await logic.previewMemberImport(seed.clubId, text, actor);
		const held = await holdGrant(
			p.officerAccessChanges.map((x) => x.approval),
			actor,
		);
		const revoking =
			kind === "session"
				? endImpersonation(actor)
				: reconcileSuperadminFlag(actor, testDb);
		try {
			await waitForLockWait(
				kind === "session"
					? 'update "impersonation_sessions"'
					: 'update "user"',
				held.pid,
			);
		} finally {
			held.release();
		}
		try {
			expect((await held.applying).officerGrants).toBe(1);
			await revoking;
			const result = await commit(
				p.officerAccessChanges.map((x) => x.approval),
				text,
				actor,
			);
			expect(result.officerGrants).toBe(0);
			expect(result.stats.membersUpdated).toBe(1);
			expect(result.officerRefreshRequired).toHaveLength(1);
			const [log] = await testDb
				.select()
				.from(activityLog)
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_edit"),
					),
				);
			expect(log.impersonatedBy).toBe(actor);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("rechecks impersonation expiry before the grant transaction commits", async () => {
		const other = await seedClub();
		const actor = other.adminUserId;
		await testDb
			.update(user)
			.set({ isSuperadmin: true })
			.where(eq(user.id, actor));
		const { startImpersonation } = await import("./impersonation-logic");
		const session = await startImpersonation(actor, {
			clubId: seed.clubId,
			mode: "read_write",
			reason: "Expiry regression",
		});
		const p = await logic.previewMemberImport(seed.clubId, text, actor);
		const activity = await import("./activity");
		const original = activity.logActivity;
		const log = vi
			.spyOn(activity, "logActivity")
			.mockImplementationOnce(async (tx, input) => {
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(session.expiresAt.getTime() + 1);
				await original(tx, input);
			});
		try {
			const result = await commit(
				p.officerAccessChanges.map((x) => x.approval),
				text,
				actor,
			);
			expect(result.officerGrants).toBe(0);
			expect(result.stats.membersUpdated).toBe(1);
			expect(await offices(seed.memberId)).toEqual([]);
		} finally {
			vi.useRealTimers();
			log.mockRestore();
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it.each([
		"person",
		"membership",
	] as const)("blocks new related %s phantoms through the actual foreign key", async (kind) => {
		const duplicate = await seedPerson({
			userId: seed.memberUserId,
			name: "Linked duplicate",
		});
		const { waitForLockWait } = await import("#/test/db");
		const p = await preview();
		const held = await holdGrant(p.officerAccessChanges.map((x) => x.approval));
		const inserting =
			kind === "person"
				? seedPerson({ userId: seed.memberUserId, name: "New linked identity" })
				: testDb
						.insert(members)
						.values({
							clubId: seed.clubId,
							personId: duplicate,
							name: "New membership",
						})
						.returning()
						.then((rows) => rows[0].id);
		let newId: string | undefined;
		try {
			await waitForLockWait(
				kind === "person" ? 'insert into "people"' : 'insert into "members"',
				held.pid,
			);
		} finally {
			held.release();
			await held.applying;
			newId = await inserting;
			if (kind === "person")
				await testDb.delete(people).where(eq(people.id, newId));
			await testDb.delete(people).where(eq(people.id, duplicate));
		}
		expect(await offices(seed.memberId)).toHaveLength(1);
	});

	it("does not mistake roster writes for a concurrent membership revoke/reinstate", async () => {
		const p = await preview();
		const importer = await import("./import-members-logic");
		const original = importer.importPeopleAndMembers;
		const importing = vi
			.spyOn(importer, "importPeopleAndMembers")
			.mockImplementationOnce(async (...args) => {
				await testDb
					.update(members)
					.set({ status: "inactive" })
					.where(eq(members.id, seed.memberId));
				await testDb
					.update(members)
					.set({ status: "active" })
					.where(eq(members.id, seed.memberId));
				return original(...args);
			});
		try {
			const result = await commit(
				p.officerAccessChanges.map((x) => x.approval),
			);
			expect(result.stats.membersUpdated).toBe(1);
			expect(result.officerGrants).toBe(0);
			expect(result.officerRefreshRequired).toHaveLength(1);
		} finally {
			importing.mockRestore();
		}
	});

	it("preserves an unaffected grant when another identity is contended", async () => {
		text = csv([
			`,Member User,member-${seed.memberUserId}@test.example,PaidMember,Club President`,
			`${randomUUID()},Independent,${randomUUID()}@test.example,PaidMember,Club Secretary`,
		]);
		const p = await preview();
		const access = await import("./import-access-state");
		const original = access.readAccessState;
		const { openBlockingTx } = await import("#/test/db");
		let blocker: Awaited<ReturnType<typeof openBlockingTx>> | undefined;
		const reading = vi
			.spyOn(access, "readAccessState")
			.mockImplementation(async (conn, clubId, actorId, target) => {
				if (target?.personId === seed.personId && !blocker) {
					blocker = await openBlockingTx(async (tx) => {
						await tx
							.select()
							.from(user)
							.where(eq(user.id, seed.memberUserId))
							.for("update");
					});
				}
				return original(conn, clubId, actorId, target);
			});
		try {
			const result = await commit(
				p.officerAccessChanges.map((x) => x.approval),
			);
			expect(result.officerGrants).toBe(1);
			expect(result.stats.membersCreated).toBe(1);
			expect(result.stats.membersUpdated).toBe(1);
			expect(result.officerRefreshRequired).toHaveLength(1);
			expect(await offices(seed.memberId)).toEqual([]);
		} finally {
			reading.mockRestore();
			await blocker?.commit();
		}
	});

	it("accepts its own admin roster updates and repeated resolutions without extra grants", async () => {
		const customerId = randomUUID();
		text = csv([
			`,Admin User,admin-${seed.adminUserId}@test.example,PaidMember,`,
			`${customerId},New Officer,,PaidMember,Club President`,
			`${customerId},New Officer,,PaidMember,Club Secretary`,
		]);
		const p = await preview();
		const result = await commit(p.officerAccessChanges.map((x) => x.approval));
		expect(result.stats.membersCreated).toBe(1);
		expect(result.officerGrants).toBe(1);
		expect(result.stats.skippedOfficerAssignments).toBe(1);
	});

	it("re-reads offices after a competing assignment waits behind a grant", async () => {
		const p = await preview();
		const held = await holdGrant(p.officerAccessChanges.map((x) => x.approval));
		const { openOfficerTermIfAbsent } = await import("./officer-terms-logic");
		const { waitForLockWait } = await import("#/test/db");
		const assigning = openOfficerTermIfAbsent(
			testDb,
			seed.memberId,
			"president",
			new Date(),
		);
		try {
			await waitForLockWait('from "members"', held.pid);
		} finally {
			held.release();
		}
		expect((await held.applying).officerGrants).toBe(1);
		expect(await assigning).toBe(false);
		expect(await offices(seed.memberId)).toHaveLength(1);
	});

	it("bounds locked access history without preventing roster import", async () => {
		await testDb.insert(officerTerms).values(
			Array.from({ length: 513 }, () => ({
				membershipId: seed.memberId,
				position: "president" as const,
				termEnd: new Date(),
			})),
		);
		const p = await preview();
		const result = await commit(p.officerAccessChanges.map((x) => x.approval));
		expect(result.officerGrants).toBe(0);
		expect(result.officerRefreshRequired).toHaveLength(1);
		expect(result.stats.membersUpdated).toBe(1);
	});

	it.each([
		"archived",
		"demoted",
	] as const)("imports roster but refuses a first grant when its admin is %s", async (change) => {
		const p = await preview();
		if (change === "archived") {
			const { archiveClub } = await import("./onboarding-logic");
			await archiveClub(seed.clubId);
		} else {
			await testDb
				.update(members)
				.set({ clubRole: "member" })
				.where(eq(members.id, seed.adminMemberId));
		}
		const result = await commit(p.officerAccessChanges.map((x) => x.approval));
		expect(result.officerGrants).toBe(0);
		expect(result.officerRefreshRequired).toHaveLength(1);
		expect(result.stats.membersUpdated).toBe(1);
		expect(await offices(seed.memberId)).toEqual([]);
	});

	it("keeps officer-bearing roster preview and import usable without a signing secret", async () => {
		const token = (await preview()).officerAccessChanges[0].approval;
		const secret = process.env.BETTER_AUTH_SECRET;
		delete process.env.BETTER_AUTH_SECRET;
		try {
			const result = await preview();
			expect(result.officerAccessChanges).toEqual([]);
			expect(result.officerAccessUnavailable).toMatch(/unavailable/i);
			expect((await commit()).stats.membersUpdated).toBe(1);
			const invalid = await commit([token]);
			expect(invalid.stats.membersUpdated).toBe(1);
			expect(invalid.officerRefreshRequired).toHaveLength(1);
			expect(await offices(seed.memberId)).toEqual([]);
		} finally {
			if (secret !== undefined) process.env.BETTER_AUTH_SECRET = secret;
		}
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
				// The other club must HOLD this member too. Otherwise the row resolves
				// to a Person only this club holds, which the other club's import now
				// refuses outright (#759), and it proposes no office to replay. Same
				// `text`, so the csv hash matches and only the club can refuse it.
				const [held] = await testDb
					.select({ personId: members.personId, name: members.name })
					.from(members)
					.where(eq(members.id, seed.memberId));
				if (!held) throw new Error("seeded member missing");
				await testDb.insert(members).values({
					clubId: other.clubId,
					personId: held.personId,
					name: held.name,
				});
				token = (
					await logic.previewMemberImport(other.clubId, text, other.adminUserId)
				).officerAccessChanges[0].approval;
				// Drop it again before `cleanup`, which deletes every Person the
				// club's roster names — including this club's member.
				await testDb
					.delete(members)
					.where(
						and(
							eq(members.clubId, other.clubId),
							eq(members.personId, held.personId),
						),
					);
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

	it("imports roster but skips grants after a competing officer writer changes access during roster import", async () => {
		const p = await preview();
		const { openBlockingTx } = await import("#/test/db");
		const { reconcileOfficerTerms } = await import("./officer-terms-logic");
		const blocker = await openBlockingTx(async (tx) => {
			await reconcileOfficerTerms(tx, seed.memberId, ["treasurer"]);
			await reconcileOfficerTerms(tx, seed.memberId, []);
		});

		const applying = commit(p.officerAccessChanges.map((x) => x.approval));
		applying.catch(() => {});
		try {
			const { waitForLockWait } = await import("#/test/db");
			await waitForLockWait('update "members"', blocker.pid);
		} finally {
			await blocker.commit();
		}
		const result = await applying;
		expect(result.stats.membersUpdated).toBe(1);
		expect(result.officerGrants).toBe(0);
		expect(result.officerRefreshRequired.join(" ")).toMatch(/refresh preview/i);

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

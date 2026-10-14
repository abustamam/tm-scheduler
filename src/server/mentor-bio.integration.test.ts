/**
 * The mentor bio and the request table (#945), DB-backed. Two halves:
 *
 *  - the MIGRATION: what the database itself holds (the bio column and its
 *    length check, the request table, the one-pending partial unique index);
 *  - `setMyMentorBio`: the member's own bio, whose row is resolved from the
 *    session and whose input names no member.
 *
 * The `setMyMentorBio` server fn cannot be invoked from vitest; its gate is
 * `requireUser` and the session's user id spread over the input, pinned by
 * `mentorship-authz.guard.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	impersonationSessions,
	members,
	mentorshipRequests,
	people,
	user,
} from "#/db/schema";
import { MENTOR_BIO_MAX } from "#/lib/mentorship";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Outside a request the impersonation marker no-ops; same stand-in as
// `mentorship.integration.test.ts`.
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => {
		throw new Error("No request context");
	},
}));

const logic = await import("./mentorship-logic");
const { isSqlState, isUniqueViolation } = await import("./pg-errors");

const createdClubs: string[] = [];
const createdUsers: string[] = [];
const createdSuperadmins: string[] = [];

afterEach(async () => {
	for (const id of createdSuperadmins) {
		await testDb
			.delete(impersonationSessions)
			.where(eq(impersonationSessions.superadminUserId, id));
		await testDb.delete(user).where(eq(user.id, id));
	}
	createdSuperadmins.length = 0;
	for (const clubId of createdClubs) await cleanup(clubId, createdUsers);
	createdClubs.length = 0;
	createdUsers.length = 0;
});

async function seed() {
	const s = await seedClub();
	createdClubs.push(s.clubId);
	createdUsers.push(s.adminUserId, s.memberUserId);
	return s;
}

async function addMember(clubId: string, name: string) {
	const [person] = await testDb
		.insert(people)
		.values({ name, email: `${randomUUID()}@test.example` })
		.returning({ id: people.id });
	if (!person) throw new Error("fixture");
	const [m] = await testDb
		.insert(members)
		.values({ clubId, personId: person.id, name })
		.returning({ id: members.id });
	if (!m) throw new Error("fixture");
	return m.id;
}

const bioOf = async (id: string) =>
	(
		await testDb
			.select({ b: members.mentorBio })
			.from(members)
			.where(eq(members.id, id))
	)[0]?.b;

/** The error a rejected statement raised, so its SQLSTATE can be read. */
async function rejection(p: PromiseLike<unknown>): Promise<unknown> {
	try {
		await p;
	} catch (err) {
		return err;
	}
	throw new Error("expected the statement to be rejected");
}

describe.skipIf(!hasTestDb)("the #945 migration", () => {
	// protects=`members.mentor_bio` exists, is null for a membership nobody
	// wrote a bio for, accepts 1-500 characters, and the DATABASE (not only the
	// zod schema) refuses 501 and the empty string;
	// fails_when=the column is missing, defaults to something other than null,
	// or the length check is absent or off by one at either end;
	// no_claim=the zod schema's own limit (the setMyMentorBio tests); counts
	// code points, which equal UTF-16 units for the ASCII used here
	it("adds members.mentor_bio, null by default, with a 1-500 length check", async () => {
		const s = await seed();
		expect(await bioOf(s.memberId)).toBeNull();
		const set = (bio: string) =>
			testDb
				.update(members)
				.set({ mentorBio: bio })
				.where(eq(members.id, s.memberId));
		await set("x".repeat(MENTOR_BIO_MAX));
		expect(await bioOf(s.memberId)).toHaveLength(MENTOR_BIO_MAX);
		expect(isSqlState(await rejection(set("x".repeat(501))), "23514")).toBe(
			true,
		);
		expect(isSqlState(await rejection(set("")), "23514")).toBe(true);
		// Refused writes changed nothing.
		expect(await bioOf(s.memberId)).toHaveLength(MENTOR_BIO_MAX);
	});

	// protects=`mentorship_requests` exists with `pending` and `new_member` as
	// defaults and refuses a request to oneself and free-text focus without
	// `other`;
	// fails_when=the table or either default is missing, or either check is
	// absent;
	// no_claim=that the same-club rule holds (checked in the Part B write path,
	// as for `mentorships`); that anything writes this table yet
	it("creates mentorship_requests with its defaults and two checks", async () => {
		const s = await seed();
		const mentor = await addMember(s.clubId, "Maya Mentor");
		const [row] = await testDb
			.insert(mentorshipRequests)
			.values({
				clubId: s.clubId,
				menteeMemberId: s.memberId,
				mentorMemberId: mentor,
			})
			.returning();
		expect(row).toMatchObject({
			status: "pending",
			focus: "new_member",
			focusOther: null,
			mentorshipId: null,
			decidedByMemberId: null,
			decidedAt: null,
		});
		const self = await rejection(
			testDb.insert(mentorshipRequests).values({
				clubId: s.clubId,
				menteeMemberId: mentor,
				mentorMemberId: mentor,
				status: "declined",
			}),
		);
		expect(isSqlState(self, "23514")).toBe(true);
		const freeText = await rejection(
			testDb.insert(mentorshipRequests).values({
				clubId: s.clubId,
				menteeMemberId: mentor,
				mentorMemberId: s.memberId,
				status: "declined",
				focus: "contest",
				focusOther: "speeches",
			}),
		);
		expect(isSqlState(freeText, "23514")).toBe(true);
	});

	// protects=one PENDING request per mentee, enforced by the database: a
	// second pending row for the same mentee fails, and withdrawing or declining
	// the first frees the slot while keeping it as history;
	// fails_when=the index is missing, is not partial (a decided request would
	// block a new one), or is keyed on the mentor as well (two mentors could
	// then be asked at once);
	// no_claim=the Part B request flow that translates the failure into a
	// message; the index is read from pg_indexes because `db:push` does not
	// update an existing partial predicate
	it("allows one pending request per mentee, and a decided one frees the slot", async () => {
		const s = await seed();
		const a = await addMember(s.clubId, "Mentor A");
		const b = await addMember(s.clubId, "Mentor B");
		const request = (mentee: string, mentor: string, status?: "pending") =>
			testDb.insert(mentorshipRequests).values({
				clubId: s.clubId,
				menteeMemberId: mentee,
				mentorMemberId: mentor,
				...(status ? { status } : {}),
			});

		await request(s.memberId, a);
		expect(isUniqueViolation(await rejection(request(s.memberId, a)))).toBe(
			true,
		);
		// A different mentor makes no difference: it is one per MENTEE.
		expect(isUniqueViolation(await rejection(request(s.memberId, b)))).toBe(
			true,
		);
		// Another mentee may ask the same mentor.
		await request(s.adminMemberId, a);

		for (const decided of ["withdrawn", "declined"] as const) {
			await testDb
				.update(mentorshipRequests)
				.set({ status: decided, decidedAt: new Date() })
				.where(eq(mentorshipRequests.menteeMemberId, s.memberId));
			await request(s.memberId, b);
			// The new pending one is the only pending one again.
			const rows = await testDb
				.select({ status: mentorshipRequests.status })
				.from(mentorshipRequests)
				.where(eq(mentorshipRequests.menteeMemberId, s.memberId));
			expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);
			expect(rows.filter((r) => r.status === decided).length).toBeGreaterThan(
				0,
			);
			expect(isUniqueViolation(await rejection(request(s.memberId, a)))).toBe(
				true,
			);
		}

		const idx = await testDb.execute(sql`
			SELECT indexdef FROM pg_indexes
			WHERE indexname = 'mentorship_requests_one_pending_unique'`);
		const def = (idx.rows[0] as { indexdef?: string } | undefined)?.indexdef;
		expect(def).toMatch(/UNIQUE/);
		expect(def).toMatch(/\(mentee_member_id\)/);
		expect(def).toMatch(/WHERE.*status.*pending/);
	});
});

describe.skipIf(!hasTestDb)("setMyMentorBio (#945)", () => {
	const save = (userId: string, clubId: string, bio: string) =>
		logic.setMyMentorBio({ userId, clubId, bio });

	// protects=a member's bio lands on THEIR OWN membership, resolved from the
	// session, and no other row in the club changes; an admin saving theirs
	// writes the admin's row, not a member's; the input schema names no member;
	// fails_when=the write follows an id from the input, or hits every row, or
	// the schema accepts memberId/userId/membershipId;
	// no_claim=that the server fn forwards the SESSION's user id (the authz
	// guard test reads that wiring)
	it("writes the caller's own row only", async () => {
		const s = await seed();
		await save(s.memberUserId, s.clubId, "I coach new speakers.");
		expect(await bioOf(s.memberId)).toBe("I coach new speakers.");
		expect(await bioOf(s.adminMemberId)).toBeNull();
		await save(s.adminUserId, s.clubId, "Contests and leadership.");
		expect(await bioOf(s.adminMemberId)).toBe("Contests and leadership.");
		expect(await bioOf(s.memberId)).toBe("I coach new speakers.");

		const base = { clubId: randomUUID(), bio: "hi" };
		expect(logic.setMyMentorBioSchema.safeParse(base).success).toBe(true);
		for (const extra of ["memberId", "userId", "membershipId"]) {
			expect(
				logic.setMyMentorBioSchema.safeParse({ ...base, [extra]: randomUUID() })
					.success,
				extra,
			).toBe(false);
		}
	});

	// protects=a bio of 500 characters is saved, 501 is refused by the schema
	// (and by the DB check, in the migration test), and a refused save leaves
	// the stored bio alone;
	// fails_when=the zod limit is missing or off by one, or the length is
	// measured before trimming (500 plus trailing spaces would be refused);
	// no_claim=surrogate pairs: zod counts UTF-16 units and the DB code points,
	// so the DB never refuses what zod admits, which this does not exercise
	it("accepts 500 characters and refuses 501", async () => {
		const s = await seed();
		const fits = "y".repeat(MENTOR_BIO_MAX);
		expect(
			logic.setMyMentorBioSchema.safeParse({ clubId: s.clubId, bio: fits })
				.success,
		).toBe(true);
		// Trailing spaces are trimmed before the limit applies.
		const padded = logic.setMyMentorBioSchema.parse({
			clubId: s.clubId,
			bio: `${fits}   `,
		});
		await save(s.memberUserId, s.clubId, padded.bio);
		expect(await bioOf(s.memberId)).toBe(fits);
		expect(
			logic.setMyMentorBioSchema.safeParse({
				clubId: s.clubId,
				bio: "y".repeat(MENTOR_BIO_MAX + 1),
			}).success,
		).toBe(false);
		expect(await bioOf(s.memberId)).toBe(fits);
	});

	// protects=the 500 ceiling is a stated number, not an accident of a refactor,
	// and a bio with a NUL character is refused by the schema with a clear
	// message (Postgres text cannot hold NUL and the write would 500), while the
	// same text without it passes;
	// fails_when=MENTOR_BIO_MAX drifts from 500 (the migration's check is a
	// literal 500), or the NUL refinement is dropped;
	// no_claim=what the form shows for the refusal (it shows the server's message)
	it("pins the 500 ceiling and refuses a NUL character", () => {
		expect(MENTOR_BIO_MAX).toBe(500);
		const parse = (bio: string) =>
			logic.setMyMentorBioSchema.safeParse({ clubId: randomUUID(), bio });
		expect(parse("Pathways help").success).toBe(true);
		for (const bad of ["Path\u0000ways", "\u0000", "ok \u0000"]) {
			const res = parse(bad);
			expect(res.success, JSON.stringify(bad)).toBe(false);
			if (!res.success) {
				expect(res.error.issues.map((i) => i.message)).toContain(
					logic.MENTOR_BIO_NUL_MESSAGE,
				);
			}
		}
	});

	// protects=an empty or whitespace-only bio clears it to null (never an
	// empty string, which the DB check refuses), and the text is stored trimmed;
	// fails_when=the empty string reaches the column, or the stored text keeps
	// its padding;
	// no_claim=that the page shows "No bio yet" for it (the component test)
	it("stores null for an empty bio and trims the rest", async () => {
		const s = await seed();
		await save(s.memberUserId, s.clubId, "Pathways help");
		expect(await save(s.memberUserId, s.clubId, "   ")).toEqual({
			mentorBio: null,
		});
		expect(await bioOf(s.memberId)).toBeNull();
		await save(s.memberUserId, s.clubId, "  Evaluations  \n");
		expect(await bioOf(s.memberId)).toBe("Evaluations");
		await save(s.memberUserId, s.clubId, "");
		expect(await bioOf(s.memberId)).toBeNull();
	});

	// protects=each save logs a member_edit on the member's own record with
	// the club, and the bio text itself is not copied into the log; someone
	// with no membership of their own (another club's member, a read-write
	// impersonator) cannot write, and nothing is logged for the attempt;
	// fails_when=the save is silent, logs a different action or target, copies
	// the bio into activity_log, or a non-member's write lands;
	// no_claim=impersonated_by attribution (the marker needs a request context
	// this file does not stand up; `mentorship.integration.test.ts` covers it
	// for the sibling flag write)
	it("logs member_edit, and refuses a non-member without logging", async () => {
		const s = await seed();
		const other = await seed();
		await save(s.memberUserId, s.clubId, "Secret sauce for speeches");
		const rows = (
			await testDb
				.select()
				.from(activityLog)
				.where(eq(activityLog.clubId, s.clubId))
		).filter(
			(r) =>
				r.action === "member_edit" &&
				(r.detail as { mentorBio?: string } | null)?.mentorBio !== undefined,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			actorMemberId: s.memberId,
			targetType: "member",
			targetId: s.memberId,
			detail: { mentorBio: "set" },
		});
		expect(JSON.stringify(rows[0]?.detail)).not.toContain("Secret");

		await expect(
			save(other.memberUserId, s.clubId, "Not mine to write"),
		).rejects.toThrow();
		const superId = randomUUID();
		await testDb.insert(user).values({
			id: superId,
			name: "Super Admin",
			email: `super-${superId}@test.example`,
			emailVerified: true,
			isSuperadmin: true,
		});
		createdSuperadmins.push(superId);
		await testDb.insert(impersonationSessions).values({
			superadminUserId: superId,
			clubId: s.clubId,
			mode: "read_write",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		await expect(save(superId, s.clubId, "Not mine to write")).rejects.toThrow(
			logic.MENTORSHIP_NOT_YOURS_MESSAGE,
		);
		expect(await bioOf(s.memberId)).toBe("Secret sauce for speeches");
		expect(await bioOf(other.memberId)).toBeNull();
		const after = await testDb
			.select()
			.from(activityLog)
			.where(eq(activityLog.clubId, s.clubId));
		expect(
			after.filter(
				(r) => (r.detail as { mentorBio?: string } | null)?.mentorBio,
			),
		).toHaveLength(1);
	});
});

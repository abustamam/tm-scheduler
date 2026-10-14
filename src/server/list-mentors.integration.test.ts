/**
 * The Find a mentor list (#945), DB-backed: who `listMentors` returns for a
 * caller, what each row carries, and that no contact detail rides along.
 *
 * The server fn cannot be invoked from vitest, so its members-only gate is held
 * two ways: `requireClubViewAccess` against a real read-only impersonation here
 * (it hands back no membership), and the fn's source, read comment-blind, which
 * must refuse that case BEFORE the reader runs.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	impersonationSessions,
	members,
	mentorships,
	people,
	user,
} from "#/db/schema";
import { MENTORS_MEMBERS_ONLY_MESSAGE } from "#/lib/mentorship";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";
import { readSource, serverFnBody } from "#/test/guard-source";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const logic = await import("./mentorship-logic");
const { requireClubViewAccess } = await import("./guards");

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

async function addMember(
	clubId: string,
	opts: {
		name: string;
		willing?: boolean;
		status?: "active" | "inactive";
		bio?: string | null;
		/** Confirmed by the member (`mentor_listed_at`); defaults to `willing`. */
		listed?: boolean;
	},
) {
	const [person] = await testDb
		.insert(people)
		.values({
			name: opts.name,
			phone: "+15555550100",
			email: `${randomUUID()}@test.example`,
		})
		.returning({ id: people.id });
	if (!person) throw new Error("fixture");
	const [m] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: person.id,
			name: opts.name,
			status: opts.status ?? "active",
			willingToMentor: opts.willing ?? true,
			mentorBio: opts.bio ?? null,
			mentorListedAt: (opts.listed ?? opts.willing ?? true) ? new Date() : null,
		})
		.returning({ id: members.id });
	if (!m) throw new Error("fixture");
	return m.id;
}

const pair = (
	clubId: string,
	mentor: string,
	mentee: string,
	over: Partial<typeof mentorships.$inferInsert> = {},
) =>
	testDb
		.insert(mentorships)
		.values({
			clubId,
			mentorMemberId: mentor,
			menteeMemberId: mentee,
			focus: "new_member",
			...over,
		})
		.returning({ id: mentorships.id });

describe.skipIf(!hasTestDb)("listMentors (#945)", () => {
	// protects=the page lists exactly the club's ACTIVE members who are willing
	// to mentor, other than the caller, by name: a willing member who is
	// inactive, a willing member of another club, and a member who is not
	// willing are all absent;
	// fails_when=the list leaks another club's mentors, includes a lapsed or
	// unwilling member, or is unordered;
	// no_claim=who may call it (the members-only tests below); counts and bios
	// (the next tests)
	it("returns the active, willing members of the caller's club, by name", async () => {
		const s = await seed();
		const other = await seed();
		const zed = await addMember(s.clubId, { name: "Zed Zimmer" });
		const abe = await addMember(s.clubId, { name: "Abe Archer" });
		await addMember(s.clubId, { name: "Ida Inactive", status: "inactive" });
		await addMember(s.clubId, { name: "Nia Notwilling", willing: false });
		await addMember(other.clubId, { name: "Olga Elsewhere" });

		const list = await logic.listMentors(s.clubId, s.memberId);
		expect(list.map((m) => m.memberId)).toEqual([abe, zed]);
		expect(list.map((m) => m.name)).toEqual(["Abe Archer", "Zed Zimmer"]);
	});

	// protects=the caller never sees themself on the list, even when they are
	// willing, and everyone else willing still appears;
	// fails_when=the exclusion is dropped, or keyed on the wrong id (the
	// person, the user) so a willing caller can "choose" themself;
	// no_claim=that a willing caller can see the page at all
	it("leaves the caller off their own list", async () => {
		const s = await seed();
		await testDb
			.update(members)
			.set({ willingToMentor: true, mentorListedAt: new Date() })
			.where(eq(members.id, s.memberId));
		const abe = await addMember(s.clubId, { name: "Abe Archer" });
		const mine = await logic.listMentors(s.clubId, s.memberId);
		expect(mine.map((m) => m.memberId)).toEqual([abe]);
		const abes = await logic.listMentors(s.clubId, abe);
		expect(abes.map((m) => m.memberId)).toEqual([s.memberId]);
	});

	// protects=activeMenteeCount is the number of people the mentor mentors NOW:
	// every active pairing with them as mentor counts, whatever its focus, and
	// an ended pairing, a pairing as MENTEE, and a pairing with a lapsed mentee
	// do not;
	// fails_when=the count includes history, counts the mentor's own mentors,
	// counts only new_member pairings, or reads 0/NaN instead of 0 for a mentor
	// with none;
	// no_claim=that the count caps anything: there is no cap (#945)
	it("counts active pairings as mentor, any focus, and nothing else", async () => {
		const s = await seed();
		const maya = await addMember(s.clubId, { name: "Maya Mentor" });
		const lone = await addMember(s.clubId, { name: "Lone Mentor" });
		const m1 = await addMember(s.clubId, { name: "Mentee 1", willing: false });
		const m2 = await addMember(s.clubId, { name: "Mentee 2", willing: false });
		const m3 = await addMember(s.clubId, { name: "Mentee 3", willing: false });
		const lapsed = await addMember(s.clubId, {
			name: "Lapsed",
			willing: false,
			status: "inactive",
		});
		const coach = await addMember(s.clubId, { name: "Her own mentor" });
		await pair(s.clubId, maya, m1, { focus: "new_member" });
		await pair(s.clubId, maya, m2, { focus: "contest" });
		await pair(s.clubId, maya, m3, { focus: null });
		// Not counted: ended, lapsed mentee, and Maya as the MENTEE.
		await pair(s.clubId, maya, s.memberId, { endedAt: new Date() });
		await pair(s.clubId, maya, lapsed);
		await pair(s.clubId, coach, maya);

		const list = await logic.listMentors(s.clubId, s.memberId);
		const byId = new Map(list.map((m) => [m.memberId, m]));
		expect(byId.get(maya)?.activeMenteeCount).toBe(3);
		expect(byId.get(lone)?.activeMenteeCount).toBe(0);
		// Another mentor's pairings do not leak into Maya's count.
		expect(byId.get(coach)?.activeMenteeCount).toBe(1);
	});

	// protects=activeMenteeCount counts PEOPLE: one mentee paired with the same
	// mentor under two foci is one person, not two;
	// fails_when=the count goes back to count(*) of pairings, so "Mentoring 2
	// people" appears for one mentee;
	// no_claim=the singular/plural wording (mentors.test.tsx)
	it("counts a mentee paired under two foci once", async () => {
		const s = await seed();
		const maya = await addMember(s.clubId, { name: "Maya Mentor" });
		const m1 = await addMember(s.clubId, { name: "Mentee 1", willing: false });
		const m2 = await addMember(s.clubId, { name: "Mentee 2", willing: false });
		await pair(s.clubId, maya, m1, { focus: "new_member" });
		await pair(s.clubId, maya, m1, { focus: "contest" });
		const list = await logic.listMentors(s.clubId, s.memberId);
		expect(list.find((m) => m.memberId === maya)?.activeMenteeCount).toBe(1);
		await pair(s.clubId, maya, m2, { focus: "contest" });
		const again = await logic.listMentors(s.clubId, s.memberId);
		expect(again.find((m) => m.memberId === maya)?.activeMenteeCount).toBe(2);
	});

	// protects=the bio is shown ONLY on Find a mentor: the admin's per-member
	// payload (`loadMemberMentorships`, also what a read-only impersonation
	// reads) carries no bio and no listing state, though the member's own view
	// still does, and the admin willing list still names an unlisted member;
	// fails_when=the admin payload spreads the member's own view again, so a
	// bio or `mentorListed` reaches an admin;
	// no_claim=who may call the admin read (the authz guard test)
	it("keeps the bio out of the admin payload", async () => {
		const s = await seed();
		const bea = await addMember(s.clubId, {
			name: "Bea Bio",
			bio: "Private-ish words.",
			listed: false,
		});
		const admin = await logic.loadMemberMentorships({
			clubId: s.clubId,
			memberId: bea,
		});
		expect(admin).not.toBeNull();
		expect(Object.keys(admin ?? {}).sort()).toEqual([
			"candidates",
			"mentees",
			"mentors",
			"willingToMentor",
		]);
		expect(JSON.stringify(admin)).not.toContain("Private-ish");
		const own = await logic.loadMyMentorships(bea);
		expect(own).toMatchObject({
			mentorBio: "Private-ish words.",
			mentorListed: false,
		});
		// Admin pairing views are unchanged: an unlisted willing member is still
		// willing there.
		const club = await logic.loadClubMentorships(s.clubId);
		expect(club.willing.map((w) => w.id)).toContain(bea);
	});

	// protects=each row carries the bio the mentor wrote (null when none) and
	// ONLY id, name, bio and count: no email, phone or user id reaches this
	// response, even though the fixture gives every person both;
	// fails_when=the reader starts selecting the Person's contact columns, or
	// returns the bio of another membership;
	// no_claim=the member page, which does show contact to club members
	it("carries the bio and no contact details", async () => {
		const s = await seed();
		const withBio = await addMember(s.clubId, {
			name: "Bea Bio",
			bio: "Pathways and evaluations.",
		});
		const noBio = await addMember(s.clubId, { name: "Cy Quiet" });
		const list = await logic.listMentors(s.clubId, s.memberId);
		expect(list).toEqual([
			{
				memberId: withBio,
				name: "Bea Bio",
				mentorBio: "Pathways and evaluations.",
				activeMenteeCount: 0,
			},
			{
				memberId: noBio,
				name: "Cy Quiet",
				mentorBio: null,
				activeMenteeCount: 0,
			},
		]);
		const wire = JSON.stringify(list);
		expect(wire).not.toMatch(/@test\.example/);
		expect(wire).not.toMatch(/5555550100/);

		// The member's own dashboard view carries their bio too.
		const mine = await logic.loadMyMentorships(withBio);
		expect(mine?.mentorBio).toBe("Pathways and evaluations.");
		expect((await logic.loadMyMentorships(noBio))?.mentorBio).toBeNull();
	});

	// protects=Find a mentor is for club members: a read-only impersonator
	// resolves to NO membership at the read gate, and the server fn refuses that
	// case with the page's message BEFORE it calls the reader; a signed-in
	// non-member is stopped by the same gate;
	// fails_when=the null-membership refusal is removed or moved after the
	// reader, or the reader is handed an id from the input;
	// no_claim=that the fn runs end to end: a createServerFn handler is
	// unreachable from vitest, so its wiring is read from source
	it("is members-only: no membership, no list", async () => {
		const s = await seed();
		const other = await seed();
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
			mode: "read_only",
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		expect((await requireClubViewAccess(superId, s.clubId)).membership).toBe(
			null,
		);
		await expect(
			requireClubViewAccess(other.memberUserId, s.clubId),
		).rejects.toThrow();
		expect(MENTORS_MEMBERS_ONLY_MESSAGE).toBe(
			"Find a mentor is for club members.",
		);

		const body = serverFnBody(
			readSource("src/server/mentorship.ts"),
			"listMentors",
		);
		const gate = body.search(
			/requireClubViewAccess\(\s*user\.id,\s*data\.clubId\s*\)/,
		);
		const refuse = body.search(
			/if\s*\(\s*!access\.membership\s*\)\s*throw new Error\(\s*MENTORS_MEMBERS_ONLY_MESSAGE\s*\)/,
		);
		const reader = body.search(
			/listMentorsDb\(\s*data\.clubId,\s*access\.membership\.id\s*\)/,
		);
		expect(gate).toBeGreaterThanOrEqual(0);
		expect(refuse).toBeGreaterThan(gate);
		expect(reader).toBeGreaterThan(refuse);
		expect(body).toMatch(/requireUser\(\)/);
	});
});

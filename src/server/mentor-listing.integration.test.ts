/**
 * Who Find a mentor lists (#945), DB-backed: `members.mentor_listed_at` is the
 * member's own confirmation that they are findable. The Easy-Speak import turns
 * `willing_to_mentor` on without the member acting, so a willing member is
 * LISTED only once they confirm; `listedMentorWhere` is the one predicate.
 *
 * Collapse's handling of the column is in `membership-collapse-logic.integration.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importRefs, members, people } from "#/db/schema";
import { cleanup, hasTestDb, seedClub, testDb } from "#/test/db";
import { readSource } from "#/test/guard-source";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// Outside a request the impersonation marker no-ops; same stand-in as
// `mentor-bio.integration.test.ts`.
vi.mock("@tanstack/react-start/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-start/server")>()),
	getRequest: () => {
		throw new Error("No request context");
	},
}));

const logic = await import("./mentorship-logic");

const createdClubs: string[] = [];
const createdUsers: string[] = [];

afterEach(async () => {
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

/** A willing member the member never confirmed: what the import leaves behind. */
async function addImportedWilling(clubId: string, name: string) {
	const [person] = await testDb
		.insert(people)
		.values({ name, email: `${randomUUID()}@test.example` })
		.returning({ id: people.id });
	if (!person) throw new Error("fixture");
	const [m] = await testDb
		.insert(members)
		.values({
			clubId,
			personId: person.id,
			name,
			willingToMentor: true,
			mentorListedAt: null,
		})
		.returning({ id: members.id });
	if (!m) throw new Error("fixture");
	return m.id;
}

const stateOf = async (id: string) =>
	(
		await testDb
			.select({
				willing: members.willingToMentor,
				listedAt: members.mentorListedAt,
			})
			.from(members)
			.where(eq(members.id, id))
	)[0];

const listedIds = async (clubId: string, caller: string) =>
	(await logic.listMentors(clubId, caller)).map((m) => m.memberId);

describe.skipIf(!hasTestDb)("the mentor listing (#945)", () => {
	// protects=a member whose willing flag was set without them acting (the
	// Easy-Speak import) is absent from Find a mentor, while a member who
	// confirmed is present; the admin's willing list still names both;
	// fails_when=listMentors goes back to filtering on willing_to_mentor alone,
	// so an imported flag shows up and starts receiving requests;
	// no_claim=that the import itself leaves the column null: the source guard
	// below holds that
	it("hides an unconfirmed willing member from the list", async () => {
		const s = await seed();
		const imported = await addImportedWilling(s.clubId, "Ida Imported");
		const confirmed = await addImportedWilling(s.clubId, "Cleo Confirmed");
		await testDb
			.update(members)
			.set({ mentorListedAt: new Date() })
			.where(eq(members.id, confirmed));

		expect(await listedIds(s.clubId, s.memberId)).toEqual([confirmed]);
		const club = await logic.loadClubMentorships(s.clubId);
		expect(club.willing.map((w) => w.id).sort()).toEqual(
			[imported, confirmed].sort(),
		);
	});

	// protects=the member confirming by turning willing on lists them, and the
	// first confirmation time is kept when they confirm again;
	// fails_when=setMyWillingToMentor(true) does not set mentor_listed_at, or
	// overwrites it on every call;
	// no_claim=that the card's button calls it (mentorship-cards.test.tsx)
	it("lists a member who confirms, and keeps the first time", async () => {
		const s = await seed();
		// The caller must be an authenticated member: use the seeded member and
		// make their row the unconfirmed one.
		await testDb
			.update(members)
			.set({ willingToMentor: true, mentorListedAt: null })
			.where(eq(members.id, s.memberId));
		expect(await listedIds(s.clubId, s.adminMemberId)).toEqual([]);

		await logic.setMyWillingToMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			willing: true,
		});
		const first = (await stateOf(s.memberId))?.listedAt;
		expect(first).toBeInstanceOf(Date);
		expect(await listedIds(s.clubId, s.adminMemberId)).toEqual([s.memberId]);

		await logic.setMyWillingToMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			willing: true,
		});
		expect((await stateOf(s.memberId))?.listedAt).toEqual(first);
	});

	// protects=turning willing off clears the listing, and turning it on again
	// is a fresh confirmation; the listing never outlives the flag;
	// fails_when=mentor_listed_at survives the flag going off, so an import or
	// a later tick re-publishes someone who had withdrawn;
	// no_claim=that the bio is cleared: it is kept (the bio tests)
	it("clears the listing when the member turns willing off", async () => {
		const s = await seed();
		await logic.setMyWillingToMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			willing: true,
		});
		expect(await listedIds(s.clubId, s.adminMemberId)).toEqual([s.memberId]);

		await logic.setMyWillingToMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			willing: false,
		});
		expect(await stateOf(s.memberId)).toEqual({
			willing: false,
			listedAt: null,
		});
		expect(await listedIds(s.clubId, s.adminMemberId)).toEqual([]);

		await logic.setMyWillingToMentor({
			userId: s.memberUserId,
			clubId: s.clubId,
			willing: true,
		});
		expect(await listedIds(s.clubId, s.adminMemberId)).toEqual([s.memberId]);
	});

	// protects=the database itself refuses a listed member who is not willing, so
	// a writer that forgets the pair (a merge, an import, a fixture) fails loudly
	// instead of leaving a row a later "willing" flip would publish unconfirmed;
	// fails_when=`members_mentor_listed_requires_willing_check` is dropped from
	// the schema or the migration, or its predicate is loosened: the first two
	// writes below succeed;
	// no_claim=that every writer clears the pair: the setter, collapse and
	// fixture tests above and beside this one do that
	it("refuses a listing on a member who is not willing", async () => {
		const s = await seed();
		const unwilling = await addImportedWilling(s.clubId, "Una Unwilling");
		await testDb
			.update(members)
			.set({ willingToMentor: false })
			.where(eq(members.id, unwilling));

		const refusedBy = async (write: Promise<unknown>) => {
			const err = await write.then(
				() => null,
				(e: unknown) => e as { cause?: { constraint?: string } },
			);
			expect(err, "the write was refused").not.toBeNull();
			return err?.cause?.constraint;
		};

		expect(
			await refusedBy(
				Promise.resolve(
					testDb
						.update(members)
						.set({ mentorListedAt: new Date() })
						.where(eq(members.id, unwilling)),
				),
			),
		).toBe("members_mentor_listed_requires_willing_check");

		// The other way round: a listed member cannot be turned unwilling alone.
		const listed = await addImportedWilling(s.clubId, "Lena Listed");
		await testDb
			.update(members)
			.set({ mentorListedAt: new Date() })
			.where(eq(members.id, listed));
		expect(
			await refusedBy(
				Promise.resolve(
					testDb
						.update(members)
						.set({ willingToMentor: false })
						.where(eq(members.id, listed)),
				),
			),
		).toBe("members_mentor_listed_requires_willing_check");

		expect(await stateOf(unwilling)).toEqual({
			willing: false,
			listedAt: null,
		});
		expect((await stateOf(listed))?.willing).toBe(true);
	});

	// protects=saving a bio while willing lists the member (writing the bio is
	// the confirmation), and saving one while NOT willing lists nobody, so a
	// later import setting the flag cannot publish it;
	// fails_when=setMyMentorBio does not set mentor_listed_at, or sets it with
	// the flag off;
	// no_claim=that clearing the bio unlists: it does not
	it("lists a willing member who saves a bio, and nobody who is not willing", async () => {
		const s = await seed();
		await logic.setMyMentorBio({
			userId: s.memberUserId,
			clubId: s.clubId,
			bio: "Evaluations.",
		});
		expect((await stateOf(s.memberId))?.listedAt).toBeNull();

		await testDb
			.update(members)
			.set({ willingToMentor: true })
			.where(eq(members.id, s.memberId));
		expect(await listedIds(s.clubId, s.adminMemberId)).toEqual([]);
		await logic.setMyMentorBio({
			userId: s.memberUserId,
			clubId: s.clubId,
			bio: "Evaluations and contests.",
		});
		expect((await stateOf(s.memberId))?.listedAt).toBeInstanceOf(Date);
		expect(await listedIds(s.clubId, s.adminMemberId)).toEqual([s.memberId]);
	});

	// protects=loadMyMentorships.mentorListed is true only for a willing member
	// with a confirmation, so the card shows its confirm line for an imported
	// flag and not for anyone else;
	// fails_when=mentorListed reports willing alone, or stays true for a member
	// who turned off (both columns cleared: the DB refuses a listed unwilling
	// row, `members_mentor_listed_requires_willing_check`);
	// no_claim=what the card renders (mentorship-cards.test.tsx)
	it("reports mentorListed on the member's own view", async () => {
		const s = await seed();
		const imported = await addImportedWilling(s.clubId, "Ida Imported");
		expect((await logic.loadMyMentorships(imported))?.mentorListed).toBe(false);
		await testDb
			.update(members)
			.set({ mentorListedAt: new Date() })
			.where(eq(members.id, imported));
		expect((await logic.loadMyMentorships(imported))?.mentorListed).toBe(true);
		await testDb
			.update(members)
			.set({ willingToMentor: false, mentorListedAt: null })
			.where(eq(members.id, imported));
		expect((await logic.loadMyMentorships(imported))?.mentorListed).toBe(false);
	});

	// protects=the Easy-Speak import never writes mentor_listed_at: its source
	// does not mention the column, so the null default is what hides an imported
	// flag;
	// fails_when=someone makes the import list the members it flags (or reuses
	// setMyWillingToMentor), publishing them without their say;
	// no_claim=a run of the import (mentor-import.integration.test.ts owns it)
	it("is not written by the mentor import", () => {
		const source = readSource("src/server/mentor-import-logic.ts");
		expect(source).not.toMatch(/mentorListedAt|mentor_listed_at/);
		expect(source).not.toMatch(/setMyWillingToMentor/);
	});

	// protects=the migration's backfill: a willing member the import touched (an
	// import_refs row of kind willing_to_mentor) stays unlisted, one who has no
	// such ref is listed, and an unwilling member stays null; the statement run
	// is the one in the migration file, narrowed to this club;
	// fails_when=the backfill lists the imported flags (publishing them on
	// deploy), lists nobody (hiding every self-made mentor), or lists the
	// unwilling;
	// no_claim=the production data (docs/agents/data-and-deploy.md: the PR's
	// Prod check); the club narrowing is the only edit to the statement
	it("backfills listing for willing members with no import ref", async () => {
		const s = await seed();
		const withRef = await addImportedWilling(s.clubId, "Ida Imported");
		const selfMade = await addImportedWilling(s.clubId, "Sam Selfmade");
		const unwilling = await addImportedWilling(s.clubId, "Una Unwilling");
		await testDb
			.update(members)
			.set({ willingToMentor: false })
			.where(eq(members.id, unwilling));
		await testDb.insert(importRefs).values({
			clubId: s.clubId,
			source: "easy_speak",
			kind: "willing_to_mentor",
			sourceId: withRef,
			targetId: withRef,
		});

		const dir = resolve(process.cwd(), "drizzle");
		const file = readdirSync(dir).find(
			(f) =>
				f.endsWith(".sql") &&
				readFileSync(resolve(dir, f), "utf8").includes(
					'ADD COLUMN "mentor_listed_at"',
				),
		);
		expect(file, "the migration that adds mentor_listed_at").toBeDefined();
		const text = readFileSync(resolve(dir, file as string), "utf8");
		const at = text.indexOf('UPDATE "members" SET "mentor_listed_at"');
		expect(at, "the backfill UPDATE").toBeGreaterThanOrEqual(0);
		const statement = text.slice(at).trim().replace(/;$/, "");
		await testDb.execute(
			sql.raw(`${statement} AND "members"."club_id" = '${s.clubId}'`),
		);

		expect((await stateOf(withRef))?.listedAt).toBeNull();
		expect((await stateOf(selfMade))?.listedAt).toBeInstanceOf(Date);
		expect((await stateOf(unwilling))?.listedAt).toBeNull();
		expect(await listedIds(s.clubId, s.adminMemberId)).toEqual([selfMade]);
	});
});

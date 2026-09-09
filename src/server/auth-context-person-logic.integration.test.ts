/**
 * DB-backed tests for the session display name (#707).
 *
 * The bug: the dashboard `<h1>` greeted every production user with their raw
 * email. `getAuthContext` returned Better-Auth's `user.name` and every consumer
 * reads `user.name || user.email`, but magic-link creates accounts with
 * `name: ""` and nothing in `src/` ever writes that column — so the `||` arm
 * that looked defensive was the branch 100% of real accounts took. Only the
 * seed and `#/test/db` write a non-empty `user.name`, which is precisely why it
 * looked fine in dev and in every existing suite.
 *
 * `getAuthContext` is a `createServerFn`, so nothing inside its handler is
 * reachable from vitest (CLAUDE.md's coverage trap). The lookup therefore lives
 * in `auth-context-person-logic.ts` and is exercised here; that
 * `getAuthContext` still CALLS it, with the active club, and still prefers it
 * over `user.name`, is held by `auth-context-name-wiring.guard.test.ts`.
 *
 * Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/auth-context-person-logic.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { user } from "#/db/auth-schema";
import { clubs, members, people } from "#/db/schema";
import { hasTestDb, testDb } from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const { loadPersonDisplayName } = await import(
	"#/server/auth-context-person-logic"
);
const { resolveUserPersonId } = await import("#/server/person-identity-logic");

// Per-run suffix: ~50 DB-backed suites share one `tm_test`, so a fixed key
// collides across files and an unscoped delete takes another file's in-flight
// rows (CLAUDE.md). Everything created here is tracked by id and deleted by id.
const SUITE_TAG = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const createdPersonIds: string[] = [];
const createdClubIds: string[] = [];

/**
 * A uuid this run owns, ordered by `nth`. Two of these differ only in the last
 * digit, so `people.id` ordering is the digit order — while the run-unique
 * prefix keeps them from colliding with a parallel suite's fixed ids.
 */
const orderedId = (nth: number): string =>
	`${SUITE_TAG}-0000-4000-8000-${String(nth).padStart(12, "0")}`;

/**
 * A PRODUCTION-shaped account: `user.name` is `""`, exactly what Better-Auth's
 * magic-link plugin writes. `#/test/db`'s `seedClub` gives its users a real
 * name, which is the fixture difference that hid this bug from the whole suite
 * — so this suite mints its own rather than reusing it.
 */
async function makeMagicLinkUser(): Promise<{ id: string; email: string }> {
	const id = randomUUID();
	const email = `p707-${SUITE_TAG}-${id}@test.example`;
	await testDb
		.insert(user)
		.values({ id, name: "", email, emailVerified: true });
	createdUserIds.push(id);
	return { id, email };
}

async function makePerson(
	userId: string | null,
	name: string,
	createdAt: Date,
	id: string = randomUUID(),
): Promise<string> {
	await testDb
		.insert(people)
		.values({ id, name, userId, createdAt, email: `${id}@test.example` });
	createdPersonIds.push(id);
	return id;
}

async function makeClub(label: string): Promise<string> {
	const [club] = await testDb
		.insert(clubs)
		.values({
			name: `Greeting ${SUITE_TAG} ${label}`,
			slug: `greeting-${SUITE_TAG}-${label}`,
		})
		.returning({ id: clubs.id });
	if (!club) throw new Error("Failed to insert club");
	createdClubIds.push(club.id);
	return club.id;
}

/** Put a Person on a club's roster. Returns the club, which is the active one. */
async function enroll(personId: string, label: string): Promise<string> {
	const clubId = await makeClub(label);
	await testDb.insert(members).values({ clubId, personId, name: "Roster Row" });
	return clubId;
}

describe.skipIf(!hasTestDb)("session display name (#707)", () => {
	afterAll(async () => {
		if (!hasTestDb) return;
		// EVERY delete is attempted even when an earlier one throws, and only
		// then do the failures surface. Three bare sequential `await`s would stop
		// at the first, and the rows that survive are the ones nothing else can
		// reach: `people` here is club-LESS (ADR-0008), so `cleanup(clubId, …)`
		// cascades from a club they do not have, and they would leak into every
		// later run of the shared database (CLAUDE.md's testing note).
		//
		// Sequential rather than `Promise.allSettled`, deliberately: `members`
		// cascades from BOTH `clubs` and `people`, so running those two deletes
		// concurrently has them take the same member-row locks in whatever order
		// each planner chooses — a deadlock that would abort one arm on a busy
		// shared database. Ordered clubs → people → user, each cascading away
		// from what the next one deletes.
		const failures: string[] = [];
		const attempt = async (what: string, run: () => Promise<unknown>) => {
			try {
				await run();
			} catch (err) {
				failures.push(`${what}: ${String(err)}`);
			}
		};
		if (createdClubIds.length > 0) {
			await attempt("clubs", () =>
				testDb.delete(clubs).where(inArray(clubs.id, createdClubIds)),
			);
		}
		if (createdPersonIds.length > 0) {
			await attempt("people", () =>
				testDb.delete(people).where(inArray(people.id, createdPersonIds)),
			);
		}
		if (createdUserIds.length > 0) {
			await attempt("user", () =>
				testDb.delete(user).where(inArray(user.id, createdUserIds)),
			);
		}
		if (failures.length > 0) {
			throw new Error(`cleanup left rows behind — ${failures.join("; ")}`);
		}
	});

	/**
	 * The control, and the whole issue in one test. Without the fix the only
	 * name this account has is on the Person row, and the greeting expression
	 * every consumer uses falls through to the email.
	 */
	it("CONTROL: a magic-link account carries no name of its own, so the greeting fell back to the email", async () => {
		const account = await makeMagicLinkUser();
		const personId = await makePerson(
			account.id,
			"Nina Patel",
			new Date("2024-01-01"),
		);
		const clubId = await enroll(personId, "control");

		const [row] = await testDb
			.select({ name: user.name })
			.from(user)
			.where(inArray(user.id, [account.id]));
		// What Better-Auth stored, and what `getAuthContext` used to hand back.
		expect(row?.name).toBe("");
		// The pre-#707 expression, verbatim, at every consumer.
		expect(row?.name || account.email).toBe(account.email);

		// The fix reads the roster instead.
		expect(await loadPersonDisplayName(account.id, clubId)).toBe("Nina Patel");
	});

	it("returns the full roster name, not a first name — the greeting splits it itself", async () => {
		const account = await makeMagicLinkUser();
		// A Toastmasters designation is part of the stored name; `greetingText`
		// (dashboard-greeting.tsx) takes the first token, and the app shell wants
		// the whole thing for the avatar initials and the account menu.
		const personId = await makePerson(
			account.id,
			"Rasheed Bustamam, DTM",
			new Date("2024-02-01"),
		);
		const clubId = await enroll(personId, "full");

		expect(await loadPersonDisplayName(account.id, clubId)).toBe(
			"Rasheed Bustamam, DTM",
		);
	});

	/**
	 * A signed-in account with nothing on any roster — the "#182 not yet
	 * provisioned" case, and the one the club-less shell already handles. Null
	 * hands the caller back to `user.name`, so the behaviour there is unchanged.
	 */
	it("returns null when no Person is linked, leaving the old fallback in place", async () => {
		const account = await makeMagicLinkUser();
		expect(await loadPersonDisplayName(account.id, null)).toBeNull();
		// And with an active club they are not on, which is the same answer by a
		// different route: rung 1 misses, rung 2 finds no Person.
		expect(
			await loadPersonDisplayName(account.id, await makeClub("unlinked")),
		).toBeNull();
	});

	it("returns null rather than a blank when the roster name is empty or whitespace", async () => {
		// `people.name` is NOT NULL but has no CHECK against blanks. Returning ""
		// would greet "Welcome back, " with nothing after it — worse than the
		// email this fix replaces, and the failure mode `??` cannot catch.
		const blank = await makeMagicLinkUser();
		const blankPerson = await makePerson(blank.id, "", new Date("2024-03-01"));
		expect(
			await loadPersonDisplayName(blank.id, await enroll(blankPerson, "blank")),
		).toBeNull();

		const spaces = await makeMagicLinkUser();
		const spacesPerson = await makePerson(
			spaces.id,
			"   ",
			new Date("2024-03-02"),
		);
		expect(
			await loadPersonDisplayName(
				spaces.id,
				await enroll(spacesPerson, "spaces"),
			),
		).toBeNull();
	});

	it("trims a stored name rather than greeting into the padding", async () => {
		const account = await makeMagicLinkUser();
		const personId = await makePerson(
			account.id,
			"  Ada Lovelace  ",
			new Date("2024-04-01"),
		);
		const clubId = await enroll(personId, "trim");
		expect(await loadPersonDisplayName(account.id, clubId)).toBe(
			"Ada Lovelace",
		);
	});

	describe("a human duplicated across clubs", () => {
		/**
		 * The edge case #707 names outright: linked to Person rows in more than
		 * one club, with a different name in each. The club you are LOOKING AT is
		 * the one whose roster spelling should greet you, so switching clubs
		 * switches the name. Without the `activeClubId` rung both calls return
		 * whichever Person the person-level resolver happens to rank first, and
		 * one of the two clubs greets you by the other club's spelling.
		 */
		it("greets by the ACTIVE club's spelling, and follows a club switch", async () => {
			const account = await makeMagicLinkUser();
			const westPerson = await makePerson(
				account.id,
				"Robert Vance",
				new Date("2021-01-01"),
			);
			const eastPerson = await makePerson(
				account.id,
				"Bob Vance",
				new Date("2024-01-01"),
			);
			const west = await enroll(westPerson, "west");
			const east = await enroll(eastPerson, "east");

			expect(await loadPersonDisplayName(account.id, west)).toBe(
				"Robert Vance",
			);
			expect(await loadPersonDisplayName(account.id, east)).toBe("Bob Vance");
		});

		/**
		 * The tiebreak the criterion actually asks about: two Persons EACH holding
		 * a membership, in the SAME active club, so the club rung cannot separate
		 * them. `people.created_at` decides. The sibling case below covers the
		 * hole that leaves.
		 *
		 * Distinct from a rostered-vs-membership-less pair, which is the
		 * membership-count tiebreak inside `resolveUserPersonId` and proves
		 * nothing about this ordering.
		 */
		it("breaks a tie inside one club by the older Person", async () => {
			const account = await makeMagicLinkUser();
			const clubId = await makeClub("same-club");
			const older = await makePerson(
				account.id,
				"Original Spelling",
				new Date("2020-01-01"),
			);
			const newer = await makePerson(
				account.id,
				"Duplicate Spelling",
				new Date("2024-01-01"),
			);
			// Inserted newest-first, so heap order is the reverse of the answer —
			// an absent ORDER BY returns the wrong row rather than the right one
			// by luck.
			for (const personId of [newer, older]) {
				await testDb
					.insert(members)
					.values({ clubId, personId, name: "Roster Row" });
			}

			expect(await loadPersonDisplayName(account.id, clubId)).toBe(
				"Original Spelling",
			);

			// Stable: two reads in one request must never disagree.
			const answers = new Set([
				await loadPersonDisplayName(account.id, clubId),
				await loadPersonDisplayName(account.id, clubId),
				await loadPersonDisplayName(account.id, clubId),
			]);
			expect(answers.size).toBe(1);
		});

		/**
		 * `people.created_at` defaults to `now()`, so two Persons minted by ONE
		 * `linkPersonToUser` statement — which binds every unlinked Person
		 * matching the verified email at once — can share a timestamp to the
		 * microsecond. `people.id` is the tertiary key that closes it; without it
		 * this is "whichever row the database returned first", which is exactly
		 * what the criterion rules out.
		 */
		it("breaks an equal-timestamp tie by id, not by heap order", async () => {
			const account = await makeMagicLinkUser();
			const clubId = await makeClub("same-instant");
			const sameInstant = new Date("2023-05-05T05:05:05.000Z");
			const lowId = orderedId(1);
			const highId = orderedId(2);
			await makePerson(account.id, "Wins By Id", sameInstant, lowId);
			await makePerson(account.id, "Loses By Id", sameInstant, highId);
			// Again inserted in the reverse of the expected order.
			for (const personId of [highId, lowId]) {
				await testDb
					.insert(members)
					.values({ clubId, personId, name: "Roster Row" });
			}

			expect(await loadPersonDisplayName(account.id, clubId)).toBe(
				"Wins By Id",
			);
		});

		/**
		 * No active club — an account whose only club was archived (#560 filters
		 * it out of the switcher, leaving `activeClubId` null) still has a name.
		 * Rung 2 is the shared canonical resolver, so the name it gives belongs to
		 * the same Person that `pathwaysForUser`, `selfPersonId` in
		 * `path-enrollment-logic` and the same in `progress-marks-logic` write to.
		 */
		it("falls back to the canonical Person when there is no active club", async () => {
			const account = await makeMagicLinkUser();
			// Older and membership-less — what an unordered query can return first.
			await makePerson(account.id, "Stale Import", new Date("2020-01-01"));
			const rostered = await makePerson(
				account.id,
				"Nina Patel",
				new Date("2024-05-01"),
			);
			await enroll(rostered, "canonical");

			expect(await resolveUserPersonId(account.id)).toBe(rostered);
			expect(await loadPersonDisplayName(account.id, null)).toBe("Nina Patel");
		});

		/**
		 * Rung 1 hitting a blank must not swallow the answer: the lookup carries
		 * on to rung 2 rather than reporting "no name" and greeting by email.
		 *
		 * The fixture is built so rung 2 lands somewhere ELSE, which is the only
		 * way this assertion can distinguish a fall-through from a stop. The
		 * blank Person holds one membership (the active club); the named one
		 * holds two, and `resolveUserPersonId` ranks by membership count first —
		 * so the canonical identity is the named row even though it is younger.
		 */
		it("falls through to the canonical Person when the active club's name is blank", async () => {
			const account = await makeMagicLinkUser();
			const blank = await makePerson(account.id, "  ", new Date("2024-06-01"));
			const clubId = await enroll(blank, "blank-active");
			const elsewhere = await makePerson(
				account.id,
				"Real Name",
				new Date("2024-06-02"),
			);
			await enroll(elsewhere, "named-elsewhere-a");
			await enroll(elsewhere, "named-elsewhere-b");

			expect(await resolveUserPersonId(account.id)).toBe(elsewhere);
			expect(await loadPersonDisplayName(account.id, clubId)).toBe("Real Name");
		});

		/**
		 * Where the ladder ENDS, pinned so nobody reads the fall-through above as
		 * "search every linked Person for a name". Both rungs land on the same
		 * blank row, so the answer is null and the consumer's existing
		 * `|| user.email` arm stands. That is the pre-#707 behaviour for this
		 * account, not a regression — `people.name` is NOT NULL and every write
		 * path demands one, so a blank is a data defect, and chasing a name
		 * through the remaining duplicates would need a third ordering to keep in
		 * step with `resolveUserPersonId` by hand.
		 */
		it("stops at the canonical Person rather than hunting for any name at all", async () => {
			const account = await makeMagicLinkUser();
			const blank = await makePerson(account.id, "   ", new Date("2024-06-03"));
			// Two memberships, so this blank row is also the canonical identity.
			const clubId = await enroll(blank, "blank-canonical-a");
			await enroll(blank, "blank-canonical-b");
			// A named duplicate exists, but it is neither the active club's row
			// nor the canonical one.
			const ignored = await makePerson(
				account.id,
				"Never Reached",
				new Date("2024-06-04"),
			);
			await enroll(ignored, "ignored");

			expect(await resolveUserPersonId(account.id)).toBe(blank);
			expect(await loadPersonDisplayName(account.id, clubId)).toBeNull();
		});
	});

	/**
	 * Impersonation (#185 / ADR-0020) forces `activeClubId` to the impersonated
	 * club, and `getSessionUser` never swaps `user.id` — so the context's `id`
	 * and `email` stay the superadmin's and the name must too. A superadmin who
	 * is not on that club's roster simply misses rung 1. The failure this rules
	 * out is a name from the club being viewed leaking onto the superadmin's own
	 * header.
	 */
	it("names the real account, never the impersonated club's roster", async () => {
		const superadmin = await makeMagicLinkUser();
		const ownPerson = await makePerson(
			superadmin.id,
			"Real Superadmin",
			new Date("2024-07-01"),
		);
		await enroll(ownPerson, "own");

		// A club they are not a member of, holding somebody else entirely.
		const other = await makeMagicLinkUser();
		const otherPerson = await makePerson(
			other.id,
			"Someone Else",
			new Date("2024-07-02"),
		);
		const viewedClub = await enroll(otherPerson, "viewed");

		expect(await loadPersonDisplayName(superadmin.id, viewedClub)).toBe(
			"Real Superadmin",
		);
	});

	it("never reaches another account's Person", async () => {
		const mine = await makeMagicLinkUser();
		const theirs = await makeMagicLinkUser();
		const minePerson = await makePerson(
			mine.id,
			"Mine Owner",
			new Date("2024-08-01"),
		);
		const theirsPerson = await makePerson(
			theirs.id,
			"Theirs Owner",
			new Date("2024-08-02"),
		);
		// One shared club, so the club rung alone cannot tell them apart — only
		// the `people.user_id` predicate can.
		const shared = await makeClub("shared");
		for (const personId of [minePerson, theirsPerson]) {
			await testDb
				.insert(members)
				.values({ clubId: shared, personId, name: "Roster Row" });
		}
		// An unlinked roster Person belongs to nobody's session.
		const orphan = await makePerson(null, "Orphan", new Date("2024-08-03"));
		await testDb
			.insert(members)
			.values({ clubId: shared, personId: orphan, name: "Roster Row" });

		expect(await loadPersonDisplayName(mine.id, shared)).toBe("Mine Owner");
		expect(await loadPersonDisplayName(theirs.id, shared)).toBe("Theirs Owner");
	});
});

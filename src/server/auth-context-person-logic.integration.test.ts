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
 * `getAuthContext` still CALLS it, and still prefers it over `user.name`, is
 * held by `auth-context-name-wiring.guard.test.ts`.
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

const { loadPersonDisplayName } = await import("./auth-context-person-logic");
const { resolveUserPersonId } = await import("./person-identity-logic");

// Per-run suffix: ~50 DB-backed suites share one `tm_test`, so a fixed key
// collides across files and an unscoped delete takes another file's in-flight
// rows (CLAUDE.md). Everything created here is tracked by id and deleted by id.
const SUITE_TAG = randomUUID().slice(0, 8);
const createdUserIds: string[] = [];
const createdPersonIds: string[] = [];
const createdClubIds: string[] = [];

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
): Promise<string> {
	const id = randomUUID();
	await testDb
		.insert(people)
		.values({ id, name, userId, createdAt, email: `${id}@test.example` });
	createdPersonIds.push(id);
	return id;
}

/** Put a Person on a roster, which is what `resolveUserPersonId` tiebreaks on. */
async function enroll(personId: string, label: string): Promise<void> {
	const [club] = await testDb
		.insert(clubs)
		.values({
			name: `Greeting ${SUITE_TAG} ${label}`,
			slug: `greeting-${SUITE_TAG}-${label}`,
		})
		.returning({ id: clubs.id });
	if (!club) throw new Error("Failed to insert club");
	createdClubIds.push(club.id);
	await testDb
		.insert(members)
		.values({ clubId: club.id, personId, name: "Roster Row" });
}

describe.skipIf(!hasTestDb)("session display name (#707)", () => {
	afterAll(async () => {
		if (!hasTestDb) return;
		// Order matters: members cascade from the club, people are club-less
		// (ADR-0008) so the cascade never reaches them, and `user` is referenced
		// by `people.user_id` (ON DELETE SET NULL) so it goes last.
		if (createdClubIds.length > 0) {
			await testDb.delete(clubs).where(inArray(clubs.id, createdClubIds));
		}
		if (createdPersonIds.length > 0) {
			await testDb.delete(people).where(inArray(people.id, createdPersonIds));
		}
		if (createdUserIds.length > 0) {
			await testDb.delete(user).where(inArray(user.id, createdUserIds));
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
		await enroll(personId, "control");

		const [row] = await testDb
			.select({ name: user.name })
			.from(user)
			.where(inArray(user.id, [account.id]));
		// What Better-Auth stored, and what `getAuthContext` used to hand back.
		expect(row?.name).toBe("");
		// The pre-#707 expression, verbatim, at every consumer.
		expect(row?.name || account.email).toBe(account.email);

		// The fix reads the roster instead.
		expect(await loadPersonDisplayName(account.id)).toBe("Nina Patel");
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
		await enroll(personId, "full");

		expect(await loadPersonDisplayName(account.id)).toBe(
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
		expect(await loadPersonDisplayName(account.id)).toBeNull();
	});

	it("returns null rather than a blank when the roster name is empty or whitespace", async () => {
		// `people.name` is NOT NULL but has no CHECK against blanks. Returning ""
		// would greet "Welcome back, " with nothing after it — worse than the
		// email this fix replaces, and the failure mode `?? ` cannot catch.
		const blank = await makeMagicLinkUser();
		const blankPerson = await makePerson(blank.id, "", new Date("2024-03-01"));
		await enroll(blankPerson, "blank");
		expect(await loadPersonDisplayName(blank.id)).toBeNull();

		const spaces = await makeMagicLinkUser();
		const spacesPerson = await makePerson(
			spaces.id,
			"   ",
			new Date("2024-03-02"),
		);
		await enroll(spacesPerson, "spaces");
		expect(await loadPersonDisplayName(spaces.id)).toBeNull();
	});

	it("trims a stored name rather than greeting into the padding", async () => {
		const account = await makeMagicLinkUser();
		const personId = await makePerson(
			account.id,
			"  Ada Lovelace  ",
			new Date("2024-04-01"),
		);
		await enroll(personId, "trim");
		expect(await loadPersonDisplayName(account.id)).toBe("Ada Lovelace");
	});

	/**
	 * `people.user_id` is not unique: duplicates predate #329's dedupe-on-write,
	 * and `linkPersonToUser` binds EVERY unlinked Person matching the verified
	 * email in one statement, so one sign-in can create several at once.
	 *
	 * The name must come off the SAME Person every other person-level surface
	 * resolves to (`resolveUserPersonId` — Pathways enrollment, progress marks,
	 * the project picker). An ad-hoc `where(eq(people.userId, …))` here would be
	 * an unordered pick, which is #437/#329's bug re-opened on a new surface:
	 * two people greeted by two different names on two page loads.
	 */
	it("names the SAME Person every other person-level surface resolves to", async () => {
		const account = await makeMagicLinkUser();
		// Older and membership-less — what an unordered query can return first.
		await makePerson(account.id, "Stale Import", new Date("2020-01-01"));
		const rostered = await makePerson(
			account.id,
			"Nina Patel",
			new Date("2024-05-01"),
		);
		await enroll(rostered, "dup");

		expect(await resolveUserPersonId(account.id)).toBe(rostered);
		expect(await loadPersonDisplayName(account.id)).toBe("Nina Patel");

		// And stable: two reads in one request must not disagree.
		const answers = new Set([
			await loadPersonDisplayName(account.id),
			await loadPersonDisplayName(account.id),
			await loadPersonDisplayName(account.id),
		]);
		expect(answers.size).toBe(1);
	});

	it("never reaches another account's Person", async () => {
		const mine = await makeMagicLinkUser();
		const theirs = await makeMagicLinkUser();
		const minePerson = await makePerson(
			mine.id,
			"Mine Owner",
			new Date("2024-06-01"),
		);
		await enroll(minePerson, "mine");
		const theirsPerson = await makePerson(
			theirs.id,
			"Theirs Owner",
			new Date("2024-06-02"),
		);
		await enroll(theirsPerson, "theirs");
		// An unlinked roster Person belongs to nobody's session.
		const orphan = await makePerson(null, "Orphan", new Date("2024-06-03"));
		await enroll(orphan, "orphan");

		expect(await loadPersonDisplayName(mine.id)).toBe("Mine Owner");
		expect(await loadPersonDisplayName(theirs.id)).toBe("Theirs Owner");
	});
});

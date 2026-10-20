/**
 * One Easy-Speak upload builds the roster and the history (#1240), against the
 * test database. The bundle is the extension's meeting rewritten to name exactly
 * the eight people the issue's fixture names.
 *
 * Run with:
 *   bunx vitest run src/server/history-import-one-upload.integration.test.ts
 * (a bootstrapped worktree has its own database; without one this skips.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activityLog,
	clubImports,
	clubs,
	guests,
	importRefs,
	meetings,
	members,
	officerTerms,
	people,
	roleSlots,
	user,
} from "#/db/schema";
import type { EasySpeakBundleV1 } from "#/lib/easy-speak-bundle";
import {
	type PersonResolution,
	personKeyOf,
} from "#/lib/easy-speak-import-plan";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

// The one seam to act between the plan and the write: the hook runs right after
// the club write lock, inside the transaction that makes the members.
const lockHook = vi.hoisted(() => ({
	run: null as null | (() => Promise<void>),
}));
vi.mock("./club-write-lock", async (importOriginal) => {
	const real = await importOriginal<typeof import("./club-write-lock")>();
	return {
		...real,
		lockClubForWrite: async (
			tx: Parameters<typeof real.lockClubForWrite>[0],
			clubId: string,
			timeout?: string,
		) => {
			await real.lockClubForWrite(tx, clubId, timeout);
			await lockHook.run?.();
		},
	};
});

const logic = await import("./history-import-logic");
const { applyMemberRemove } = await import("./members-logic");
const { collapseMemberships } = await import("./membership-collapse-logic");

const FIXTURE = resolve(
	__dirname,
	"../../extension/lib/__fixtures__/easy-speak/bundle.expected.json",
);
const NOW = new Date("2026-10-12T12:00:00Z");

const P = (n: number) => `9001${String(n).padStart(2, "0")}`;
const ref = (esUserId: string, name: string) => ({ esUserId, name });

/** The issue's fixture: P1 President, P2 Member, P3 Inactive, P4 meeting-only, P5 guest, P6 erased, P7 Ada, P8 Sam. */
function bundleText(mutate?: (b: EasySpeakBundleV1) => void): string {
	const bundle = JSON.parse(readFileSync(FIXTURE, "utf8")) as EasySpeakBundleV1;
	const past = bundle.meetings.find((m) => m.esMeetingId === "644304");
	if (!past) throw new Error("fixture changed");
	bundle.meetings = [
		{
			...past,
			roles: [
				{ role: "Timer", slot: 1, holder: ref(P(4), "Tom Pastmeeting") },
				{ role: "Grammarian", slot: 2, holder: ref(P(6), "Forgotten User") },
				{ role: "Toastmaster", slot: 3, holder: ref(P(7), "Ada Linked") },
				{ role: "Ah-Counter", slot: 4, holder: ref(P(8), "Sam Same") },
			],
			attendance: [],
			guests: [{ who: ref(P(5), "Gia Guest"), category: "visitor" }],
			awards: [],
			tableTopics: [],
		},
	];
	bundle.people = [
		{
			esUserId: P(1),
			name: "Pia President",
			status: "President",
			joined: "2020-01-02",
		},
		{ esUserId: P(2), name: "Mo Member", status: "Member", joined: null },
		{
			esUserId: P(3),
			name: "Ines Inactive",
			status: "Inactive Member",
			joined: null,
		},
	];
	bundle.mentors = [];
	bundle.speechRequests = [];
	bundle.visitorsIntroduced = [];
	mutate?.(bundle);
	return JSON.stringify(bundle);
}

const CONTACTS = [
	"Pia President, pia.president@contacts.example, 555-0101",
	"Mo Member, mo.taken@contacts.example, 555-0102",
	"Ines Inactive, ines.first@contacts.example,",
	"Ines Inactive, ines.second@contacts.example, 555-0999",
	"Tom Pastmeeting, shared.mail@contacts.example,",
	"Gia Guest, shared.mail@contacts.example,",
	"Ada Linked, ada.new@contacts.example, 555-0107",
	"Nobody Known, nobody@contacts.example, 555-0108",
].join("\n");
const CONTACT_VALUES = [
	"pia.president@contacts.example",
	"mo.taken@contacts.example",
	"ines.first@contacts.example",
	"ines.second@contacts.example",
	"shared.mail@contacts.example",
	"ada.new@contacts.example",
	"nobody@contacts.example",
	"555-0101",
	"555-0102",
	"555-0107",
	"555-0108",
	"555-0999",
	"5550101",
	"5550102",
	"5550107",
];

describe.skipIf(!hasTestDb)(
	"one upload builds roster and history (#1240)",
	() => {
		let seed: SeededClub;
		let superadminId: string;
		let adaPersonId: string;
		let adaMemberId: string;
		let samMemberId: string | undefined;
		const extraPeople: string[] = [];
		const extraUsers: string[] = [];

		beforeEach(async () => {
			lockHook.run = null;
			extraResolutions = {};
			samMemberId = undefined;
			seed = await seedClub();
			superadminId = randomUUID();
			await testDb.insert(user).values({
				id: superadminId,
				name: "Super",
				email: `super-${superadminId}@test.example`,
				emailVerified: true,
				isSuperadmin: true,
			});
			extraUsers.push(superadminId);
			await testDb
				.update(clubs)
				.set({ timezone: "America/Los_Angeles" })
				.where(eq(clubs.id, seed.clubId));
			for (const [name, email] of [
				["Ada Linked", "ada.old@contacts.example"],
				["Sam Same", null],
				["Sam Same", null],
			] as const) {
				const [person] = await testDb
					.insert(people)
					.values({ name, email })
					.returning({ id: people.id });
				const [member] = await testDb
					.insert(members)
					.values({
						clubId: seed.clubId,
						personId: person?.id as string,
						name,
						clubRole: "member",
						status: "active",
					})
					.returning({ id: members.id });
				if (name === "Ada Linked") {
					adaPersonId = person?.id as string;
					adaMemberId = member?.id as string;
				} else samMemberId = samMemberId ?? (member?.id as string);
			}
		});

		afterEach(async () => {
			lockHook.run = null;
			await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
			if (extraPeople.length) {
				await testDb
					.delete(people)
					.where(inArray(people.id, extraPeople.splice(0)));
			}
			await testDb.delete(user).where(inArray(user.id, extraUsers.splice(0)));
		});

		const upload = (mutate?: (b: EasySpeakBundleV1) => void) =>
			logic.storeEasySpeakBundle({
				clubId: seed.clubId,
				uploadedByUserId: superadminId,
				text: bundleText(mutate),
			});
		const SAM: PersonResolution = { action: "member", memberId: "" };
		let extraResolutions: Record<string, PersonResolution> = {};
		const resolutions = (): Record<string, PersonResolution> => ({
			[`es:${P(8)}`]: { ...SAM, memberId: samMemberId as string },
			...extraResolutions,
		});
		const preview = (importId: string, contacts?: string) =>
			logic.previewEasySpeakImport({
				clubId: seed.clubId,
				importId,
				resolutions: resolutions(),
				contacts,
				now: NOW,
			});
		const apply = (importId: string, contacts?: string, planHash?: string) =>
			logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId,
				superadminUserId: superadminId,
				resolutions: resolutions(),
				contacts,
				planHash,
				now: NOW,
			});

		const memberByName = async (name: string) => {
			const [row] = await testDb
				.select({
					id: members.id,
					personId: members.personId,
					status: members.status,
					endedAt: members.endedAt,
					clubRole: members.clubRole,
				})
				.from(members)
				.where(and(eq(members.clubId, seed.clubId), eq(members.name, name)));
			return row;
		};
		const personRow = async (personId: string) => {
			const [row] = await testDb
				.select({ email: people.email, phone: people.phone })
				.from(people)
				.where(eq(people.id, personId));
			return row;
		};
		const refsFor = async (key: string) =>
			testDb
				.select({ targetId: importRefs.targetId })
				.from(importRefs)
				.where(
					and(
						eq(importRefs.clubId, seed.clubId),
						eq(importRefs.kind, "person"),
						eq(importRefs.sourceId, `es:${key}`),
					),
				);
		const n = async (query: PromiseLike<Array<{ n: number }>>) =>
			Number((await query)[0]?.n ?? 0);
		/** The rows an apply may add, for this club. */
		async function tally() {
			return {
				people: await n(
					testDb
						.select({ n: count() })
						.from(people)
						.where(
							sql`${people.id} in (select person_id from members where club_id = ${seed.clubId}) or ${people.id} in (select person_id from guests where club_id = ${seed.clubId})`,
						),
				),
				members: await n(
					testDb
						.select({ n: count() })
						.from(members)
						.where(eq(members.clubId, seed.clubId)),
				),
				officerTerms: await n(
					testDb
						.select({ n: count() })
						.from(officerTerms)
						.innerJoin(members, eq(members.id, officerTerms.membershipId))
						.where(eq(members.clubId, seed.clubId)),
				),
				importRefs: await n(
					testDb
						.select({ n: count() })
						.from(importRefs)
						.where(eq(importRefs.clubId, seed.clubId)),
				),
				meetings: await n(
					testDb
						.select({ n: count() })
						.from(meetings)
						.where(eq(meetings.clubId, seed.clubId)),
				),
				guests: await n(
					testDb
						.select({ n: count() })
						.from(guests)
						.where(eq(guests.clubId, seed.clubId)),
				),
				memberAdds: await n(
					testDb
						.select({ n: count() })
						.from(activityLog)
						.where(
							and(
								eq(activityLog.clubId, seed.clubId),
								eq(activityLog.action, "member_add"),
							),
						),
				),
			};
		}

		// protects=an applied upload leaves exactly the members the rules promise
		// (2 active, one an admin with one open president term; 2 former with
		// ended_at NULL), one guest, nothing for the erased account, and a `person`
		// ref for each of the four new members;
		// fails_when=a former member is made active, an officer is not an admin or has
		// no term, a Forgotten User gets a Person, or a ref is missing;
		// no_claim=the roles and attendance written for those members are the older
		// integration suites'; the bundle is the extension's meeting, rewritten.
		it("creates the members, the term and the refs the plan promised", async () => {
			const stored = await upload();
			const shown = await preview(stored.importId);
			expect(shown.canApply).toBe(true);
			expect(shown.counts).toMatchObject({
				linkedMembers: 2,
				newActiveMembers: 2,
				newOfficers: 1,
				newFormerMembers: 2,
				erasedAccounts: 1,
			});
			const before = await tally();
			const { report } = await apply(
				stored.importId,
				undefined,
				shown.planHash,
			);

			const pia = await memberByName("Pia President");
			const mo = await memberByName("Mo Member");
			const ines = await memberByName("Ines Inactive");
			const tom = await memberByName("Tom Pastmeeting");
			expect(pia).toMatchObject({ status: "active", clubRole: "admin" });
			expect(mo).toMatchObject({ status: "active", clubRole: "member" });
			expect(ines).toMatchObject({ status: "former", endedAt: null });
			expect(tom).toMatchObject({ status: "former", endedAt: null });
			const terms = await testDb
				.select({
					position: officerTerms.position,
					termEnd: officerTerms.termEnd,
				})
				.from(officerTerms)
				.where(eq(officerTerms.membershipId, pia?.id as string));
			expect(terms).toEqual([{ position: "president", termEnd: null }]);
			expect(await memberByName("Forgotten User")).toBeUndefined();
			const guestNames = await testDb
				.select({ name: guests.name })
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(guestNames).toEqual([{ name: "Gia Guest" }]);
			for (const [key, made] of [
				[P(1), pia],
				[P(2), mo],
				[P(3), ines],
				[P(4), tom],
			] as const) {
				expect(await refsFor(key)).toEqual([{ targetId: made?.id }]);
			}
			expect(await refsFor(P(6))).toEqual([]);
			const after = await tally();
			expect(after.members - before.members).toBe(4);
			expect(after.guests - before.guests).toBe(1);
			expect(report.created.members).toEqual({
				active: 2,
				former: 2,
				officers: 1,
			});
			const added = await n(
				testDb
					.select({ n: count() })
					.from(activityLog)
					.where(
						and(
							eq(activityLog.clubId, seed.clubId),
							eq(activityLog.action, "member_add"),
						),
					),
			);
			// One member_add per created member, attributed to the superadmin.
			expect(added).toBe(4);
		});

		// protects=applying the same import again adds no Person, member, officer
		// term, import ref or meeting, even after a created member was renamed on the
		// roster (the ref, not the name, finds them);
		// fails_when=a re-apply re-derives "create" from the name and duplicates the
		// person;
		// no_claim=a person whose member row was deleted is the older tombstone tests'.
		it("is idempotent, and resolves a renamed member through their ref", async () => {
			const stored = await upload();
			await apply(stored.importId);
			const afterFirst = await tally();
			await apply(stored.importId);
			expect(await tally()).toEqual(afterFirst);

			await testDb
				.update(members)
				.set({ name: "Mo Renamed" })
				.where(eq(members.name, "Mo Member"));
			await apply(stored.importId);
			expect(await tally()).toEqual(afterFirst);
			expect(await memberByName("Mo Member")).toBeUndefined();
		});

		// protects=a contact row fills a blank email and phone on a created member; a
		// linked member who already has an email keeps it (a blank phone is filled);
		// an email another Person holds is not set and the report names the row and
		// the person; two rows for one person use the first; one email on two
		// people's rows goes to neither; a row that names nobody sets nothing;
		// fails_when=a held email is set, a linked member's email is overwritten, the
		// second row wins, or a shared email lands on one of its two people;
		// no_claim=Gia Guest is a guest, not a member being linked or created, so her
		// row matches no one: guests get no contact fill.
		it("places contacts by the issue's rules", async () => {
			const holder = await testDb
				.insert(people)
				.values({ name: "Someone Else", email: "MO.TAKEN@contacts.example" })
				.returning({ id: people.id });
			extraPeople.push(holder[0]?.id as string);
			const stored = await upload();
			const shown = await preview(stored.importId, CONTACTS);
			const { report } = await apply(stored.importId, CONTACTS, shown.planHash);

			const pia = await memberByName("Pia President");
			const mo = await memberByName("Mo Member");
			const ines = await memberByName("Ines Inactive");
			const tom = await memberByName("Tom Pastmeeting");
			expect(await personRow(pia?.personId as string)).toEqual({
				email: "pia.president@contacts.example",
				phone: "+15550101",
			});
			// Held by someone else: email blank, the phone still lands.
			expect(await personRow(mo?.personId as string)).toEqual({
				email: null,
				phone: "+15550102",
			});
			// The first row of two.
			expect(await personRow(ines?.personId as string)).toEqual({
				email: "ines.first@contacts.example",
				phone: null,
			});
			// One email on two rows, and Gia is no member: Tom's row has the only claim
			// on it among members, so the shared-email rule applies only when both are
			// targets; here it is Tom's alone.
			expect(await personRow(tom?.personId as string)).toEqual({
				email: "shared.mail@contacts.example",
				phone: null,
			});
			// A linked member keeps their email; the blank phone is filled.
			expect(await personRow(adaPersonId)).toEqual({
				email: "ada.old@contacts.example",
				phone: "+15550107",
			});

			const notes = (report.contactNotes ?? []).join("\n");
			expect(notes).toMatch(/row 2[^\n]*Mo Member/u);
			expect(notes).toMatch(/row 4[^\n]*Ines Inactive/u);
			expect(notes).toMatch(/row 6[^\n]*no one/u);
			expect(notes).toMatch(/row 8[^\n]*no one/u);
			for (const v of CONTACT_VALUES) expect(notes).not.toContain(v);
		});

		// protects=a linked member's blank email is filled only for a Person with no
		// GavelUp account who belongs to this club alone; otherwise it stays blank,
		// the phone still fills, and the report says why;
		// fails_when=the isNull(people.userId) or soleHoldingClub clause is dropped
		// from the email UPDATE;
		// no_claim=the happy path (a created member's email) is the contacts test above.
		it("leaves a linked member's email blank when the Person has an account", async () => {
			const accountUser = randomUUID();
			await testDb.insert(user).values({
				id: accountUser,
				name: "Ada Account",
				email: `ada-${accountUser}@test.example`,
				emailVerified: true,
			});
			extraUsers.push(accountUser);
			await testDb
				.update(people)
				.set({ email: null, userId: accountUser })
				.where(eq(people.id, adaPersonId));
			const stored = await upload();
			const shown = await preview(stored.importId, CONTACTS);
			const { report } = await apply(stored.importId, CONTACTS, shown.planHash);
			expect(await personRow(adaPersonId)).toEqual({
				email: null,
				phone: "+15550107",
			});
			expect((report.contactNotes ?? []).join("\n")).toMatch(
				/row 7[^\n]*left blank for Ada Linked/u,
			);
		});

		// protects=a linked member whose Person belongs to another club keeps a blank
		// email (the email is theirs to add) while the blank phone is filled, and the
		// report names the row and the person;
		// fails_when=the soleHoldingClub clause is dropped and the email is written;
		// no_claim=the account case above is a different clause.
		it("leaves a linked member's email blank when another club holds the Person", async () => {
			const other = await seedClub();
			try {
				await testDb.insert(members).values({
					clubId: other.clubId,
					personId: adaPersonId,
					name: "Ada Linked",
					clubRole: "member",
					status: "active",
				});
				await testDb
					.update(people)
					.set({ email: null })
					.where(eq(people.id, adaPersonId));
				const stored = await upload();
				const shown = await preview(stored.importId, CONTACTS);
				const { report } = await apply(
					stored.importId,
					CONTACTS,
					shown.planHash,
				);
				expect(await personRow(adaPersonId)).toEqual({
					email: null,
					phone: "+15550107",
				});
				expect((report.contactNotes ?? []).join("\n")).toMatch(
					/row 7[^\n]*left blank for Ada Linked/u,
				);
			} finally {
				await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
			}
		});

		// protects=one email on the rows of two people being created goes to neither;
		// fails_when=the first of the two keeps it;
		// no_claim=none beyond protects.
		it("gives an email on two different people's rows to neither", async () => {
			const stored = await upload();
			const contacts =
				"Mo Member, dup@contacts.example,\nTom Pastmeeting, dup@contacts.example,";
			await apply(stored.importId, contacts);
			for (const name of ["Mo Member", "Tom Pastmeeting"]) {
				const m = await memberByName(name);
				expect((await personRow(m?.personId as string))?.email).toBeNull();
			}
		});

		// protects=nothing the superadmin pasted is kept by the import: no contact
		// email or phone appears in the club_imports row (bundle, import state or
		// report), though the values are on the people;
		// fails_when=the contacts text, or a value from it, is written to
		// club_imports, a warning or the report;
		// no_claim=the activity log and the people rows hold what they should; this
		// reads the one row the import owns.
		it("stores no contact value in club_imports", async () => {
			const stored = await upload();
			await apply(stored.importId, CONTACTS);
			const [row] = await testDb
				.select({ all: sql<string>`${clubImports}::text` })
				.from(clubImports)
				.where(eq(clubImports.id, stored.importId));
			expect(row?.all).toContain("importState");
			for (const v of CONTACT_VALUES) expect(row?.all).not.toContain(v);
			const pia = await memberByName("Pia President");
			expect((await personRow(pia?.personId as string))?.email).toBe(
				"pia.president@contacts.example",
			);
		});

		// protects=the plan hash moves with the contacts text, so an apply that
		// confirmed one paste is refused for another;
		// fails_when=the hash ignores the contacts and a changed paste applies
		// unseen;
		// no_claim=none beyond protects.
		it("changes the plan hash with the contacts and refuses a stale one", async () => {
			const stored = await upload();
			const none = await preview(stored.importId);
			const some = await preview(stored.importId, CONTACTS);
			const other = await preview(
				stored.importId,
				`${CONTACTS}\nX Y, x@y.example,`,
			);
			expect(new Set([none.planHash, some.planHash, other.planHash]).size).toBe(
				3,
			);
			await expect(
				apply(stored.importId, "Mo Member, m@contacts.example,", some.planHash),
			).rejects.toThrow(logic.PLAN_CHANGED_MESSAGE);
		});

		// protects=an email taken after the preview, inside the apply's own
		// transaction, is left blank and the report says so, instead of two Persons
		// holding one email;
		// fails_when=the in-transaction re-check is missing and the email is set;
		// no_claim=a race is simulated by writing from a second connection at the lock.
		it("re-checks an email inside the apply transaction", async () => {
			const stored = await upload();
			const contacts = "Pia President, race@contacts.example,";
			const shown = await preview(stored.importId, contacts);
			lockHook.run = async () => {
				lockHook.run = null;
				const [taker] = await testDb
					.insert(people)
					.values({ name: "Late Taker", email: "race@contacts.example" })
					.returning({ id: people.id });
				extraPeople.push(taker?.id as string);
			};
			const { report } = await apply(stored.importId, contacts, shown.planHash);
			const pia = await memberByName("Pia President");
			expect((await personRow(pia?.personId as string))?.email).toBeNull();
			expect(report.contactNotes).toEqual([
				"The email in row 1 was taken since the preview; left blank for Pia President.",
			]);
			expect(JSON.stringify(report)).not.toContain("race@contacts.example");
		});

		// protects=a former member made by an import has no officer term and no admin
		// role, and an existing member's role and term count are untouched;
		// fails_when=the linked member is changed by an apply that only links them;
		// no_claim=none beyond protects.
		it("leaves a linked member's role and terms alone", async () => {
			const stored = await upload();
			await apply(stored.importId);
			const ada = await memberByName("Ada Linked");
			expect(ada).toMatchObject({ id: adaMemberId, clubRole: "member" });
			const open = await n(
				testDb
					.select({ n: count() })
					.from(officerTerms)
					.where(
						and(
							eq(officerTerms.membershipId, adaMemberId),
							isNull(officerTerms.termEnd),
						),
					),
			);
			expect(open).toBe(0);
		});

		// protects=a saved "guest" answer on a person a `guest` ref already names does
		// not mint a second guest and Person on a re-apply;
		// fails_when=the saved answer overrides the ref with guestId null;
		// no_claim=a different kind in the saved answer is not decided here.
		it("re-applying with a saved guest answer keeps the one guest", async () => {
			extraResolutions = {
				[`es:${P(5)}`]: { action: "guest", kind: "visitor" },
			};
			const stored = await upload();
			await apply(stored.importId);
			const afterFirst = await tally();
			await apply(stored.importId);
			const afterSecond = await tally();
			expect(afterSecond).toEqual(afterFirst);
			// No second member_add either: the removal-proof refs hold on re-apply.
			expect(afterSecond.memberAdds).toBe(4);
			expect(afterSecond.guests).toBe(1);
			expect(afterSecond.people).toBe(afterFirst.people);
		});

		// protects=a guest keeps the linked member who introduced them even when the
		// guest's name sorts before the introducer's;
		// fails_when=the introducer is read from a map the sorted loop has not filled;
		// no_claim=Gia Guest sorts before Sam Same, the linked introducer.
		it("keeps the introducer of a guest who sorts before a linked introducer", async () => {
			const stored = await upload((b) => {
				b.visitorsIntroduced = [
					{
						visitor: ref(P(5), "Gia Guest"),
						introducedBy: ref(P(8), "Sam Same"),
					},
				];
			});
			await apply(stored.importId);
			const [gia] = await testDb
				.select({ introducedBy: guests.introducedByMemberId })
				.from(guests)
				.where(
					and(eq(guests.clubId, seed.clubId), eq(guests.name, "Gia Guest")),
				);
			expect(gia?.introducedBy).toBe(samMemberId);
		});

		// protects=a malformed contact row (no delimiter, so email and phone sit in
		// the name cell) and a NUL in a pasted name appear nowhere in club_imports,
		// and the apply still succeeds;
		// fails_when=a warning echoes the pasted name cell, or notes skip the jsonb scrub;
		// no_claim=the well-formed rows are the other contact tests'.
		it("never stores a pasted name cell, even a malformed or NUL one", async () => {
			const contacts = [
				"Zed Nobody zed.nobody@contacts.example 555-0199",
				"Nul\u0000Person, nul.person@contacts.example, 555-0198",
				"Pia President, pia.president@contacts.example,",
			].join("\n");
			const stored = await upload();
			const shown = await preview(stored.importId, contacts);
			await apply(stored.importId, contacts, shown.planHash);
			const [row] = await testDb
				.select({ all: sql<string>`${clubImports}::text` })
				.from(clubImports)
				.where(eq(clubImports.id, stored.importId));
			for (const v of [
				"zed.nobody@contacts.example",
				"555-0199",
				"Zed Nobody",
				"nul.person@contacts.example",
				"555-0198",
				"Nul",
			]) {
				expect(row?.all).not.toContain(v);
			}
			expect(row?.all).toContain("matches no one");
		});

		// protects=a saved "guest" answer on a person whose member ref is still live
		// (made a member by the first apply) mints ONE guest and Person across any
		// number of re-applies;
		// fails_when=the guest id is kept only when the automatic outcome is a guest,
		// so every re-apply mints another (putRef is DO NOTHING);
		// no_claim=the removal of the member row the answer leaves behind.
		it("a saved guest answer beside a live member ref mints one guest across re-applies", async () => {
			const stored = await upload();
			await apply(stored.importId);
			expect(await memberByName("Tom Pastmeeting")).toBeDefined();
			extraResolutions = {
				[`es:${P(4)}`]: { action: "guest", kind: "visitor" },
			};
			await apply(stored.importId);
			await apply(stored.importId);
			await apply(stored.importId);
			const tom = await testDb
				.select({ id: guests.id })
				.from(guests)
				.where(
					and(
						eq(guests.clubId, seed.clubId),
						eq(guests.name, "Tom Pastmeeting"),
					),
				);
			expect(tom).toHaveLength(1);
			expect((await tally()).guests).toBe(2);
		});

		// protects=a saved guest answer whose KIND changed updates the stored guest's
		// kind, so the preview, the answer and the record agree;
		// fails_when=the kept guest id skips the write and the kind stays as first made;
		// no_claim=an automatic (ref/category) outcome never rewrites a kind a human set.
		it("a changed guest kind in the saved answer updates the stored guest", async () => {
			extraResolutions = {
				[`es:${P(5)}`]: { action: "guest", kind: "visitor" },
			};
			const stored = await upload();
			await apply(stored.importId);
			extraResolutions = {
				[`es:${P(5)}`]: { action: "guest", kind: "visiting_toastmaster" },
			};
			await apply(stored.importId);
			const rows = await testDb
				.select({ kind: guests.kind })
				.from(guests)
				.where(
					and(eq(guests.clubId, seed.clubId), eq(guests.name, "Gia Guest")),
				);
			expect(rows).toEqual([{ kind: "visiting_toastmaster" }]);
		});

		// protects=an imported officer removed through the real removal is a tombstone:
		// the removal's own `member_remove` row, not a null actor, says so;
		// fails_when=the tombstone is read from `member_add` rows with no actor;
		// no_claim=a member the import only linked, the next tests.
		it("does not re-create an imported officer removed through applyMemberRemove", async () => {
			const stored = await upload();
			await apply(stored.importId);
			const pia = await memberByName("Pia President");
			await applyMemberRemove({
				clubId: seed.clubId,
				memberId: pia?.id as string,
				actorMemberId: null,
			});
			const before = await tally();
			await apply(stored.importId);
			expect(await memberByName("Pia President")).toBeUndefined();
			expect(await tally()).toEqual(before);
		});

		// protects=a member the import only LINKED, then removed by the club, is not
		// re-created either;
		// fails_when=the tombstone is limited to members the import made;
		// no_claim=a removal that the club logged elsewhere than applyMemberRemove.
		it("does not re-create a linked officer the club removed", async () => {
			const [person] = await testDb
				.insert(people)
				.values({ name: "Pia President", email: null })
				.returning({ id: people.id });
			extraPeople.push(person?.id as string);
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId: person?.id as string,
				name: "Pia President",
				clubRole: "member",
				status: "active",
			});
			const stored = await upload();
			await apply(stored.importId);
			const pia = await memberByName("Pia President");
			expect(pia?.personId).toBe(person?.id);
			await applyMemberRemove({
				clubId: seed.clubId,
				memberId: pia?.id as string,
				actorMemberId: null,
			});
			await apply(stored.importId);
			expect(await memberByName("Pia President")).toBeUndefined();
		});

		// protects=a linked member who was added under superadmin impersonation (a null
		// actor) and later MERGED away is not a tombstone: the person is matched by name
		// again (D4 of #1196), their history kept;
		// fails_when=a null-actor member_add row is read as "the import made this";
		// no_claim=what the merge does to the keeper's own history.
		it("a null-actor member_add on a merged-away member is not a tombstone", async () => {
			const stored = await upload();
			await apply(stored.importId);
			await testDb.insert(activityLog).values({
				clubId: seed.clubId,
				actorMemberId: null,
				action: "member_add",
				targetType: "member",
				targetId: adaMemberId,
				detail: { name: "Ada Linked" },
			});
			const [keeperPerson] = await testDb
				.insert(people)
				.values({ name: "Ada Keeper", email: null })
				.returning({ id: people.id });
			extraPeople.push(keeperPerson?.id as string);
			const [keeper] = await testDb
				.insert(members)
				.values({
					clubId: seed.clubId,
					personId: keeperPerson?.id as string,
					name: "Ada Keeper",
					clubRole: "member",
					status: "active",
				})
				.returning({ id: members.id });
			await testDb.transaction((tx) =>
				collapseMemberships(tx, seed.clubId, keeper?.id as string, adaMemberId),
			);
			await apply(stored.importId);
			const back = await memberByName("Ada Linked");
			expect(back).toBeDefined();
		});

		// protects=one list entry plus a name-only meeting reference of the same name
		// make ONE member, and the reference resolves to it on this and every re-apply;
		// fails_when=the reference is created apart, or its ref is not stored;
		// no_claim=two namesakes with distinct ids, a plan test.
		it("makes one member of a list entry and its name-only meeting reference", async () => {
			const stored = await upload((b) => {
				const past = b.meetings[0];
				past?.roles.push({
					role: "Timekeeper Two",
					slot: 9,
					holder: { esUserId: null, name: "pia president" },
				});
			});
			await apply(stored.importId);
			const piaId = (await memberByName("Pia President"))?.id as string;
			const held = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.assignedMemberId, piaId));
			expect(held.length).toBeGreaterThan(0);
			await apply(stored.importId);
			const rows = await testDb
				.select({ id: members.id })
				.from(members)
				.where(
					and(
						eq(members.clubId, seed.clubId),
						eq(members.name, "Pia President"),
					),
				);
			expect(rows).toHaveLength(1);
			const alias = await testDb
				.select({ targetId: importRefs.targetId })
				.from(importRefs)
				.where(
					and(
						eq(importRefs.clubId, seed.clubId),
						eq(importRefs.kind, "person"),
						eq(
							importRefs.sourceId,
							personKeyOf({ esUserId: null, name: "pia president" }),
						),
					),
				);
			expect(alias).toEqual([{ targetId: rows[0]?.id }]);
		});

		const aliasBundle = (b: EasySpeakBundleV1) => {
			b.meetings[0]?.roles.push({
				role: "Timekeeper Two",
				slot: 9,
				holder: { esUserId: null, name: "pia president" },
			});
		};

		// protects=a merged alias stores its own ref on the apply that made the member,
		// so renaming that member before the next apply neither re-creates a former
		// member nor links the alias to a later namesake;
		// fails_when=the alias is left to be matched by name on the next apply;
		// no_claim=the alias-less list entry, which resolves through its own ref.
		it("keeps a merged alias on the created member after the member is renamed", async () => {
			const stored = await upload(aliasBundle);
			await apply(stored.importId);
			const pia = await memberByName("Pia President");
			await testDb
				.update(members)
				.set({ name: "Pia Renamed" })
				.where(eq(members.id, pia?.id as string));
			const before = await tally();
			await apply(stored.importId);
			expect(await memberByName("Pia President")).toBeUndefined();
			expect((await tally()).members).toBe(before.members);
			expect((await tally()).people).toBe(before.people);
			const held = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(eq(roleSlots.assignedMemberId, pia?.id as string));
			expect(held.length).toBeGreaterThan(0);
		});

		// protects=a replayed saved guest answer does not revert a kind an officer
		// changed in the app, while an answer CHANGED in the import still applies;
		// fails_when=every re-apply rewrites the kind from the saved answer;
		// no_claim=an answer the import changes, the test above.
		it("a replayed saved guest answer leaves a kind the app changed", async () => {
			extraResolutions = {
				[`es:${P(5)}`]: { action: "guest", kind: "visitor" },
			};
			const stored = await upload();
			await apply(stored.importId);
			await testDb
				.update(guests)
				.set({ kind: "visiting_toastmaster" })
				.where(
					and(eq(guests.clubId, seed.clubId), eq(guests.name, "Gia Guest")),
				);
			await apply(stored.importId);
			const rows = await testDb
				.select({ kind: guests.kind })
				.from(guests)
				.where(
					and(eq(guests.clubId, seed.clubId), eq(guests.name, "Gia Guest")),
				);
			expect(rows).toEqual([{ kind: "visiting_toastmaster" }]);
		});

		// protects=a member_remove row of a convert-undo that KEPT the membership
		// (membershipDeleted false) is not a tombstone;
		// fails_when=every member_remove row on a missing member id counts;
		// no_claim=a removal through applyMemberRemove, covered above.
		it("does not treat a kept-membership undo as a tombstone", async () => {
			const stored = await upload();
			await apply(stored.importId);
			const pia = await memberByName("Pia President");
			await applyMemberRemove({
				clubId: seed.clubId,
				memberId: pia?.id as string,
				actorMemberId: null,
			});
			await testDb
				.update(activityLog)
				.set({ detail: { name: "Pia President", membershipDeleted: false } })
				.where(
					and(
						eq(activityLog.clubId, seed.clubId),
						eq(activityLog.action, "member_remove"),
						eq(activityLog.targetId, pia?.id as string),
					),
				);
			await apply(stored.importId);
			expect(await memberByName("Pia President")).toBeDefined();
		});

		// protects=a merged alias acting as a guest's introducer is found;
		// fails_when=the introducer is looked up only among plan.people;
		// no_claim=an introducer who is not a member.
		it("finds a merged alias as a guest's introducer", async () => {
			const stored = await upload((b) => {
				aliasBundle(b);
				b.visitorsIntroduced = [
					{
						visitor: ref(P(5), "Gia Guest"),
						introducedBy: { esUserId: null, name: "pia president" },
					},
				];
			});
			await apply(stored.importId);
			const pia = await memberByName("Pia President");
			const [gia] = await testDb
				.select({ by: guests.introducedByMemberId })
				.from(guests)
				.where(
					and(eq(guests.clubId, seed.clubId), eq(guests.name, "Gia Guest")),
				);
			expect(gia?.by).toBe(pia?.id);
		});

		const twinRef = personKeyOf({ esUserId: null, name: "dupe twin" });
		const refForKey = async (key: string) =>
			testDb
				.select({ kind: importRefs.kind, targetId: importRefs.targetId })
				.from(importRefs)
				.where(
					and(eq(importRefs.clubId, seed.clubId), eq(importRefs.sourceId, key)),
				);
		const twinsBundle = (b: EasySpeakBundleV1) => {
			for (const n of [9, 10]) {
				b.people.push({
					esUserId: P(n),
					name: "Dupe Twin",
					status: "Member",
					joined: null,
				});
			}
			b.meetings[0]?.roles.push({
				role: "Timekeeper Two",
				slot: 9,
				holder: { esUserId: null, name: "dupe twin" },
			});
		};

		// protects=two es: namesakes plus a name-only meeting reference: the reference is
		// DEFERRED (apply succeeds, nothing written for it: no member, guest, ref or saved
		// answer, a preview note names it) and, with both namesakes now on the roster, the
		// NEXT preview asks about it with both as real candidates;
		// fails_when=the reference blocks the apply with no candidates, is guessed onto one
		// namesake, or a ref or answer is stored for it;
		// no_claim=a single namesake, the merge tests above.
		it("defers a name-only reference beside two namesakes, then asks with both as candidates", async () => {
			const stored = await upload(twinsBundle);
			const first = await preview(stored.importId);
			expect(first.people.find((p) => p.key === twinRef)).toMatchObject({
				status: "skipped",
				needsDecision: false,
			});
			expect(first.warnings.join("\n")).toMatch(/dupe twin.*more than one/u);
			await apply(stored.importId);
			const twins = await testDb
				.select({ id: members.id })
				.from(members)
				.where(
					and(eq(members.clubId, seed.clubId), eq(members.name, "Dupe Twin")),
				);
			expect(twins).toHaveLength(2);
			expect(await refForKey(twinRef)).toEqual([]);
			const held = await testDb
				.select({ id: roleSlots.id })
				.from(roleSlots)
				.where(
					inArray(
						roleSlots.assignedMemberId,
						twins.map((t) => t.id),
					),
				);
			expect(held).toEqual([]);
			const second = await preview(stored.importId);
			expect(second.savedResolutions[twinRef]).toBeUndefined();
			const again = second.people.find((p) => p.key === twinRef);
			expect(again).toMatchObject({
				status: "ambiguous",
				needsDecision: true,
			});
			expect(again?.candidates.map((c) => c.memberId).sort()).toEqual(
				twins.map((t) => t.id).sort(),
			);
		});

		// protects=a list-only es: person with a saved guest answer beside a name-only
		// reference is no fold: the reference is deferred and nothing is minted for it
		// (no guest, no alias ref), instead of a pending guest applied after a merge;
		// fails_when=the answer is moved onto the merged reference and a guest or alias is made;
		// no_claim=the single-target merge, covered above.
		it("defers a name-only reference when the list-only target has a saved guest answer", async () => {
			extraResolutions = {
				[`es:${P(9)}`]: { action: "guest", kind: "visitor" },
			};
			const stored = await upload((b) => {
				b.people.push({
					esUserId: P(9),
					name: "Dupe Guesty",
					status: "Member",
					joined: null,
				});
				b.meetings[0]?.roles.push({
					role: "Timekeeper Two",
					slot: 9,
					holder: { esUserId: null, name: "dupe guesty" },
				});
			});
			await apply(stored.importId);
			expect(await memberByName("Dupe Guesty")).toBeDefined();
			const minted = await testDb
				.select({ id: guests.id })
				.from(guests)
				.where(
					and(eq(guests.clubId, seed.clubId), eq(guests.name, "Dupe Guesty")),
				);
			expect(minted).toEqual([]);
			expect(
				await refForKey(personKeyOf({ esUserId: null, name: "dupe guesty" })),
			).toEqual([]);
		});

		// protects=an existing address differing in case or by surrounding blanks
		// still counts as held, so it is not written to a second Person;
		// fails_when=the holder lookup compares with bare lower();
		// no_claim=an address held only by a guest-only Person is ignored by design.
		it("treats an address held with other case and blanks as held", async () => {
			const [holder] = await testDb
				.insert(people)
				.values({ name: "Holder", email: "  MO.Held@Contacts.Example " })
				.returning({ id: people.id });
			extraPeople.push(holder?.id as string);
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId: holder?.id as string,
				name: "Holder",
				clubRole: "member",
				status: "active",
			});
			const stored = await upload();
			const contacts = "Mo Member, mo.held@contacts.example,";
			const shown = await preview(stored.importId, contacts);
			expect(shown.contacts.warnings.join("\n")).toMatch(/already belongs/u);
			await apply(stored.importId, contacts, shown.planHash);
			const mo = await memberByName("Mo Member");
			expect((await personRow(mo?.personId as string))?.email).toBeNull();
		});

		// protects=the in-transaction holder check also folds case and blanks: an
		// address another Person takes between preview and apply as " RACE.Case@... "
		// is still held;
		// fails_when=emailHeldByOther compares with bare lower();
		// no_claim=the preview-time lookup is the test above.
		it("re-checks a held address with other case and blanks inside the apply", async () => {
			const stored = await upload();
			const contacts = "Pia President, race.case@contacts.example,";
			const shown = await preview(stored.importId, contacts);
			lockHook.run = async () => {
				lockHook.run = null;
				const [taker] = await testDb
					.insert(people)
					.values({ name: "Case Taker", email: " RACE.Case@Contacts.Example " })
					.returning({ id: people.id });
				extraPeople.push(taker?.id as string);
				await testDb.insert(members).values({
					clubId: seed.clubId,
					personId: taker?.id as string,
					name: "Case Taker",
					clubRole: "member",
					status: "active",
				});
			};
			await apply(stored.importId, contacts, shown.planHash);
			const pia = await memberByName("Pia President");
			expect((await personRow(pia?.personId as string))?.email).toBeNull();
		});

		// protects=a linked member's email taken by another Person between preview and
		// apply is left blank with a note by row and name;
		// fails_when=fillMemberContact skips its own holder check;
		// no_claim=the created-member race is the test above this block.
		it("notes a linked member's email taken since the preview", async () => {
			await testDb
				.update(people)
				.set({ email: null })
				.where(eq(people.id, adaPersonId));
			const stored = await upload();
			const contacts = "Ada Linked, ada.race@contacts.example,";
			const shown = await preview(stored.importId, contacts);
			lockHook.run = async () => {
				lockHook.run = null;
				const [taker] = await testDb
					.insert(people)
					.values({ name: "Late Taker", email: "ada.race@contacts.example" })
					.returning({ id: people.id });
				extraPeople.push(taker?.id as string);
			};
			const { report } = await apply(stored.importId, contacts, shown.planHash);
			expect((await personRow(adaPersonId))?.email).toBeNull();
			expect(report.contactNotes).toEqual([
				"The email in row 1 was taken since the preview; left blank for Ada Linked.",
			]);
		});

		// protects=a person on the member list who a meeting also files under a guest
		// category becomes a member (precedence 5), not a guest;
		// fails_when=the guest category outranks the member list;
		// no_claim=none beyond protects.
		it("makes a listed member of a person also in a guest category", async () => {
			const stored = await upload((b) => {
				b.people.push({
					esUserId: P(5),
					name: "Gia Guest",
					status: "Member",
					joined: null,
				});
			});
			await apply(stored.importId);
			expect(await memberByName("Gia Guest")).toMatchObject({
				status: "active",
			});
			const guestRows = await testDb
				.select({ id: guests.id })
				.from(guests)
				.where(eq(guests.clubId, seed.clubId));
			expect(guestRows).toEqual([]);
		});

		// protects=the president term opens at midnight of the club's own day, not the
		// UTC day;
		// fails_when=the term start is computed in UTC;
		// no_claim=the term's end and the position are the first test's.
		it("starts the officer term in the club's timezone", async () => {
			const stored = await upload();
			// 02:00Z on the 12th is still the 11th in Los Angeles (UTC-7).
			await logic.applyEasySpeakImport({
				clubId: seed.clubId,
				importId: stored.importId,
				superadminUserId: superadminId,
				resolutions: resolutions(),
				now: new Date("2026-10-12T02:00:00Z"),
			});
			const pia = await memberByName("Pia President");
			const [term] = await testDb
				.select({ start: officerTerms.termStart })
				.from(officerTerms)
				.where(eq(officerTerms.membershipId, pia?.id as string));
			expect(term?.start?.toISOString()).toBe("2026-10-11T07:00:00.000Z");
		});
	},
);

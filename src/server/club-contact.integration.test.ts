/**
 * DB-backed tests for phone on the club payloads. Run with:
 *   TEST_DATABASE_URL=postgresql://dev:dev@localhost:5432/tm_test \
 *     bunx vitest run src/server/club-contact.integration.test.ts
 *
 * These import `#/server/club-logic` rather than the `createServerFn`s in
 * `club.ts`: a server fn cannot be called from a test (no session, no RPC
 * layer), so the directly-testable db logic lives in a sibling `*-logic.ts`
 * that the handlers call — the same split as `members-logic.ts`. The functions
 * exercised here ARE the ones the handlers run, not a mirror of them.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clubs, members } from "#/db/schema";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	testDb,
} from "#/test/db";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

describe.skipIf(!hasTestDb)("club payload phone normalization", () => {
	let seed: SeededClub;
	beforeEach(async () => {
		seed = await seedClub();
		// A row as stored BEFORE normalize-on-write (#295/#397).
		await testDb
			.update(members)
			.set({ phone: "(415) 555-2671" })
			.where(eq(members.id, seed.memberId));
	});
	afterEach(async () => {
		await cleanup(seed.clubId, [seed.adminUserId, seed.memberUserId]);
	});

	it("listClubMembers returns phone, coalesced to E.164", async () => {
		const { loadClubMembers } = await import("#/server/club-logic");
		const rows = await loadClubMembers(seed.clubId);
		const row = rows.find((r) => r.id === seed.memberId);
		expect(row?.phone).toBe("+14155552671");
	});

	it("getMemberProfile returns phone, coalesced to E.164", async () => {
		const { loadMemberProfile } = await import("#/server/club-logic");
		const row = await loadMemberProfile(seed.clubId, seed.memberId);
		expect(row?.phone).toBe("+14155552671");
	});

	it("getMemberProfile carries the STORED bytes alongside the coalesced number", async () => {
		// The edit dialog prefills from `phoneRaw`, so the two fields must DIVERGE
		// wherever coalescing changes anything — a `phoneRaw` that silently aliased
		// `phone` would pass a bare "is it defined" assertion while putting the
		// country-code guess straight back into the input.
		//
		// "x12" is an extension, so coalescing welds it into the subscriber number:
		// the guess is visibly not a number anyone typed, which is the point. The
		// member profile is the only screen showing what is actually on file.
		const { loadMemberProfile } = await import("#/server/club-logic");
		await testDb
			.update(members)
			.set({ phone: "415-555-2671 x12" })
			.where(eq(members.id, seed.memberId));

		const row = await loadMemberProfile(seed.clubId, seed.memberId);
		expect(row?.phoneRaw).toBe("415-555-2671 x12");
		expect(row?.phone).toBe("+1415555267112");
		expect(row?.phoneRaw).not.toBe(row?.phone);
	});

	it("getMemberProfile's phoneRaw is byte-exact, including surrounding space", async () => {
		// `coalesceToE164` does not trim, but `toE164` does before parsing, so a
		// padded value is the one shape where a `phoneRaw` implemented as
		// "coalesce, then undo" would diverge from the column.
		const { loadMemberProfile } = await import("#/server/club-logic");
		await testDb
			.update(members)
			.set({ phone: "  call the office  " })
			.where(eq(members.id, seed.memberId));

		expect(
			(await loadMemberProfile(seed.clubId, seed.memberId))?.phoneRaw,
		).toBe("  call the office  ");
	});

	it("both payloads normalize with the CLUB's country code, not the default", async () => {
		// Pins that `loadClubDefaultCountryCode` is actually consulted: with the
		// code hard-coded to the `+1` default this UK number normalizes to garbage.
		const { loadClubMembers, loadMemberProfile } = await import(
			"#/server/club-logic"
		);
		await testDb
			.update(clubs)
			.set({ defaultCountryCode: "+44" })
			.where(eq(clubs.id, seed.clubId));
		await testDb
			.update(members)
			.set({ phone: "020 7946 0018" })
			.where(eq(members.id, seed.memberId));

		const rows = await loadClubMembers(seed.clubId);
		expect(rows.find((r) => r.id === seed.memberId)?.phone).toBe(
			"+442079460018",
		);
		expect((await loadMemberProfile(seed.clubId, seed.memberId))?.phone).toBe(
			"+442079460018",
		);
	});

	it("keeps an un-normalizable phone as stored rather than dropping it", async () => {
		// `toStoredPhone` stores input with no derivable number verbatim, and the
		// roster editor's phone field has no digit requirement (`members-logic.ts`
		// validates it as a plain nullable string) — so this is a REACHABLE stored
		// value, not just legacy data. `toE164` returns null for it; both payloads
		// must still carry the text, because `WhatsAppPhoneLink` renders a
		// digit-less value as readable plain text instead of a dead link.
		const { loadClubMembers, loadMemberProfile } = await import(
			"#/server/club-logic"
		);
		await testDb
			.update(members)
			.set({ phone: "call the office" })
			.where(eq(members.id, seed.memberId));

		const rows = await loadClubMembers(seed.clubId);
		expect(rows.find((r) => r.id === seed.memberId)?.phone).toBe(
			"call the office",
		);
		expect((await loadMemberProfile(seed.clubId, seed.memberId))?.phone).toBe(
			"call the office",
		);
	});

	it("leaves a null phone null", async () => {
		const { loadClubMembers, loadMemberProfile } = await import(
			"#/server/club-logic"
		);
		await testDb
			.update(members)
			.set({ phone: null })
			.where(eq(members.id, seed.memberId));

		const rows = await loadClubMembers(seed.clubId);
		expect(rows.find((r) => r.id === seed.memberId)?.phone).toBeNull();
		expect(
			(await loadMemberProfile(seed.clubId, seed.memberId))?.phone,
		).toBeNull();
	});

	it("loadMemberProfile is scoped to the club, not just the member id", async () => {
		// The membership id is globally unique, so a missing `clubId` predicate
		// would still return the row — and the handler would happily serve one
		// club's member contact to an authorized member of ANOTHER club.
		const { loadMemberProfile } = await import("#/server/club-logic");
		const other = await seedClub();
		try {
			expect(
				await loadMemberProfile(other.clubId, seed.memberId),
			).toBeUndefined();
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});

	it("loadClubMembers returns only this club's roster, name-ordered", async () => {
		const { loadClubMembers } = await import("#/server/club-logic");
		const other = await seedClub();
		try {
			// Inserted LAST but sorting FIRST, so this fails if the `orderBy` is
			// dropped: with two fixture rows already in insertion order, asserting
			// "the result is sorted" would pass on an unordered scan.
			await testDb.insert(members).values({
				clubId: seed.clubId,
				personId: await seedPerson({ name: "Aaron Aardvark" }),
				name: "Aaron Aardvark",
			});

			const rows = await loadClubMembers(seed.clubId);
			expect(rows.some((r) => r.id === other.memberId)).toBe(false);
			expect(rows[0]?.name).toBe("Aaron Aardvark");
			expect(rows.map((r) => r.name)).toEqual([
				"Aaron Aardvark",
				"Admin User",
				"Member User",
			]);
		} finally {
			await cleanup(other.clubId, [other.adminUserId, other.memberUserId]);
		}
	});
});

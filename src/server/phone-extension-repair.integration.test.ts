/**
 * Migration 0112 (#1106): cut the extension digits off stored `+1` phones.
 *
 * The migration is hand-written data SQL that `db:generate` never reproduces
 * (it emits only the CREATE TABLE). This test runs the file's OWN statements,
 * read out of the SQL file and never re-typed, against seeded rows inside a
 * transaction it rolls back. A regenerated file that lost them fails here.
 *
 * The WhatsApp case runs the real `loadRosterWithContact` over a member stored
 * the way the bug stored it, then over the same member typed with its extension
 * after the fix, and checks both link to the main number.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clubCharterHelpers, guests, people } from "#/db/schema";
import { whatsappHref } from "#/lib/whatsapp";
import {
	cleanup,
	hasTestDb,
	type SeededClub,
	seedClub,
	seedPerson,
	setMemberPhone,
	testDb,
	withGuestPerson,
} from "#/test/db";
import { loadRosterWithContact } from "./meeting-contacts-logic";

vi.mock("#/db", async () => ({ db: (await import("#/test/db")).testDb }));

const DRIZZLE = resolve(process.cwd(), "drizzle");
const FILE = readdirSync(DRIZZLE).find((f) => /^0112_.*\.sql$/.test(f));

/** The migration's data statements: everything but the CREATE TABLE. */
function dataStatements(): string[] {
	if (!FILE) throw new Error("drizzle/0112_*.sql is missing");
	const all = readFileSync(join(DRIZZLE, FILE), "utf8")
		.split("--> statement-breakpoint")
		.map((s) => s.replace(/^(?:[ \t]*(?:--[^\n]*)?\n)+/, "").trim())
		.filter((s) => s.length > 0 && !/^CREATE TABLE/.test(s));
	// One atomic backup-and-rewrite per table with a phone column.
	expect(all.filter((s) => /^WITH old AS/.test(s))).toHaveLength(3);
	expect(all).toHaveLength(3);
	return all;
}

class Rollback extends Error {}
type Tx = Parameters<Parameters<(typeof testDb)["transaction"]>[0]>[0];

const WITH_EXT = "+141555526719"; // +1 415 555 2671 ext. 9, as stored today
const DOMESTIC_EXT = "+1141555526719"; // 1-415-555-2671 x9, as stored today
const MAIN = "+14155552671";

async function runMigration(tx: Tx) {
	for (const s of dataStatements()) await tx.execute(sql.raw(s));
}

describe.skipIf(!hasTestDb)("0112 repairs stored phone extensions", () => {
	let club: SeededClub;
	const personIds: string[] = [];

	beforeAll(async () => {
		club = await seedClub();
	});
	afterAll(async () => {
		for (const id of personIds) {
			await testDb.delete(people).where(eq(people.id, id));
		}
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	async function seedPhones() {
		const seeded = {
			ext: await seedPerson({ phone: WITH_EXT }),
			domesticExt: await seedPerson({ phone: DOMESTIC_EXT }),
			clean: await seedPerson({ phone: MAIN }),
			uk: await seedPerson({ phone: "+442079460958" }),
			text: await seedPerson({ phone: "call the office" }),
			domestic1: await seedPerson({ phone: "+115551234567" }),
			none: await seedPerson({ phone: null }),
		};
		personIds.push(...Object.values(seeded));
		const [guest] = await testDb
			.insert(guests)
			// `guests.person_id` is NOT NULL (#1125). The phone stays on the dead
			// `guests.phone` column on purpose: migration 0112 repaired THAT column, and
			// this test runs its statements as they were.
			.values({
				...(await withGuestPerson({ clubId: club.clubId, name: "G" })),
				phone: WITH_EXT,
			})
			.returning({ id: guests.id });
		const [guestDom] = await testDb
			.insert(guests)
			.values({
				...(await withGuestPerson({ clubId: club.clubId, name: "G2" })),
				phone: DOMESTIC_EXT,
			})
			.returning({ id: guests.id });
		const [helper] = await testDb
			.insert(clubCharterHelpers)
			.values({
				clubId: club.clubId,
				role: "sponsor",
				name: "H",
				phone: WITH_EXT,
			})
			.returning({ id: clubCharterHelpers.id });
		const [helperDom] = await testDb
			.insert(clubCharterHelpers)
			.values({
				clubId: club.clubId,
				role: "club_mentor",
				name: "H2",
				phone: DOMESTIC_EXT,
			})
			.returning({ id: clubCharterHelpers.id });
		return {
			seeded,
			guestId: guest?.id ?? "",
			guestDomId: guestDom?.id ?? "",
			helperId: helper?.id ?? "",
			helperDomId: helperDom?.id ?? "",
		};
	}

	const personPhone = async (tx: Tx, id: string) =>
		(
			await tx.select({ p: people.phone }).from(people).where(eq(people.id, id))
		)[0]?.p;
	const guestPhone = async (tx: Tx, id: string) =>
		(
			await tx.select({ p: guests.phone }).from(guests).where(eq(guests.id, id))
		)[0]?.p;
	const helperPhone = async (tx: Tx, id: string) =>
		(
			await tx
				.select({ p: clubCharterHelpers.phone })
				.from(clubCharterHelpers)
				.where(eq(clubCharterHelpers.id, id))
		)[0]?.p;

	async function backupsFor(tx: Tx, ids: string[]) {
		return (
			await tx.execute(
				sql`SELECT source_table, row_id, phone FROM phone_extension_backup
					WHERE row_id IN (${sql.join(
						ids.map((i) => sql`${i}::uuid`),
						sql`, `,
					)})`,
			)
		).rows as Array<{ source_table: string; row_id: string; phone: string }>;
	}

	it("rewrites folded +1 numbers in all three tables, leaves the rest, backs up exactly the changed rows", async () => {
		const f = await seedPhones();
		const s = f.seeded;
		const allIds = [
			...Object.values(s),
			f.guestId,
			f.guestDomId,
			f.helperId,
			f.helperDomId,
		];

		try {
			await testDb.transaction(async (tx) => {
				await runMigration(tx);

				expect(await personPhone(tx, s.ext)).toBe(MAIN);
				expect(await personPhone(tx, s.domesticExt)).toBe(MAIN);
				expect(await personPhone(tx, s.clean)).toBe(MAIN);
				expect(await personPhone(tx, s.uk)).toBe("+442079460958");
				expect(await personPhone(tx, s.text)).toBe("call the office");
				expect(await personPhone(tx, s.domestic1)).toBe("+115551234567");
				expect(await personPhone(tx, s.none)).toBeNull();
				expect(await guestPhone(tx, f.guestId)).toBe(MAIN);
				expect(await guestPhone(tx, f.guestDomId)).toBe(MAIN);
				expect(await helperPhone(tx, f.helperId)).toBe(MAIN);
				expect(await helperPhone(tx, f.helperDomId)).toBe(MAIN);

				// One backup row per changed row, holding the original value.
				const backups = await backupsFor(tx, allIds);
				expect(backups).toHaveLength(6);
				const original = (table: string, id: string) =>
					backups.find((b) => b.source_table === table && b.row_id === id)
						?.phone;
				expect(original("people", s.ext)).toBe(WITH_EXT);
				expect(original("people", s.domesticExt)).toBe(DOMESTIC_EXT);
				expect(original("guests", f.guestId)).toBe(WITH_EXT);
				expect(original("guests", f.guestDomId)).toBe(DOMESTIC_EXT);
				expect(original("club_charter_helpers", f.helperId)).toBe(WITH_EXT);
				expect(original("club_charter_helpers", f.helperDomId)).toBe(
					DOMESTIC_EXT,
				);

				// Idempotent: a second run changes no phone and adds no backup.
				await runMigration(tx);
				expect(await personPhone(tx, s.ext)).toBe(MAIN);
				expect(await personPhone(tx, s.domesticExt)).toBe(MAIN);
				expect(await personPhone(tx, s.domestic1)).toBe("+115551234567");
				expect(await guestPhone(tx, f.guestId)).toBe(MAIN);
				expect(await helperPhone(tx, f.helperDomId)).toBe(MAIN);
				expect(await backupsFor(tx, allIds)).toHaveLength(6);
				throw new Rollback();
			});
		} catch (e) {
			if (!(e instanceof Rollback)) throw e;
		}
	});

	it("a row re-dirtied after a repair is repaired again and the backup keeps the FIRST original", async () => {
		const f = await seedPhones();
		const id = f.seeded.ext;
		try {
			await testDb.transaction(async (tx) => {
				await runMigration(tx);
				expect(await personPhone(tx, id)).toBe(MAIN);
				await tx
					.update(people)
					.set({ phone: "+1415555267199" })
					.where(eq(people.id, id));
				await runMigration(tx);
				expect(await personPhone(tx, id)).toBe(MAIN);
				const rows = (await backupsFor(tx, [id])).filter(
					(b) => b.source_table === "people",
				);
				expect(rows).toHaveLength(1);
				expect(rows[0]?.phone).toBe(WITH_EXT);
				throw new Rollback();
			});
		} catch (e) {
			if (!(e instanceof Rollback)) throw e;
		}
	});

	it("a WhatsApp nudge link for a member typed with an extension targets the main number", async () => {
		await setMemberPhone(club.memberId, "+1 415 555 2671 ext. 9");
		const roster = await loadRosterWithContact(club.clubId);
		const me = roster.find((r) => r.id === club.memberId);
		expect(me?.phone).toBe(MAIN);
		expect(whatsappHref(me?.phone, "mobile")).toContain("14155552671");
		expect(whatsappHref(me?.phone, "mobile")).not.toContain("141555526719");
	});
});

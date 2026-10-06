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
	// One capture and one rewrite per table with a phone column.
	expect(
		all.filter((s) => /^INSERT INTO "phone_extension_backup"/.test(s)),
	).toHaveLength(3);
	expect(all.filter((s) => /^UPDATE /.test(s))).toHaveLength(3);
	return all;
}

class Rollback extends Error {}

const WITH_EXT = "+141555526719"; // +1 415 555 2671 ext. 9, as stored today
const MAIN = "+14155552671";

describe.skipIf(!hasTestDb)("0112 repairs stored phone extensions", () => {
	let club: SeededClub;
	const personIds: string[] = [];

	beforeAll(async () => {
		club = await seedClub();
	});
	afterAll(async () => {
		await testDb
			.delete(people)
			.where(eq(people.id, personIds[0] ?? club.personId));
		for (const id of personIds.slice(1))
			await testDb.delete(people).where(eq(people.id, id));
		await cleanup(club.clubId, [club.adminUserId, club.memberUserId]);
	});

	it("rewrites folded +1 numbers, leaves the rest, and backs up exactly the changed rows", async () => {
		const seeded = {
			ext: await seedPerson({ phone: WITH_EXT }),
			clean: await seedPerson({ phone: MAIN }),
			uk: await seedPerson({ phone: "+442079460958" }),
			text: await seedPerson({ phone: "call the office" }),
			domestic1: await seedPerson({ phone: "+115551234567" }),
			none: await seedPerson({ phone: null }),
		};
		personIds.push(...Object.values(seeded));
		const [guest] = await testDb
			.insert(guests)
			.values({ clubId: club.clubId, name: "G", phone: WITH_EXT })
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

		try {
			await testDb.transaction(async (tx) => {
				for (const s of dataStatements()) await tx.execute(sql.raw(s));

				const phoneOf = async (id: string) =>
					(
						await tx
							.select({ p: people.phone })
							.from(people)
							.where(eq(people.id, id))
					)[0]?.p;
				expect(await phoneOf(seeded.ext)).toBe(MAIN);
				expect(await phoneOf(seeded.clean)).toBe(MAIN);
				expect(await phoneOf(seeded.uk)).toBe("+442079460958");
				expect(await phoneOf(seeded.text)).toBe("call the office");
				expect(await phoneOf(seeded.domestic1)).toBe("+115551234567");
				expect(await phoneOf(seeded.none)).toBeNull();
				expect(
					(
						await tx
							.select({ p: guests.phone })
							.from(guests)
							.where(eq(guests.id, guest?.id ?? ""))
					)[0]?.p,
				).toBe(MAIN);
				expect(
					(
						await tx
							.select({ p: clubCharterHelpers.phone })
							.from(clubCharterHelpers)
							.where(eq(clubCharterHelpers.id, helper?.id ?? ""))
					)[0]?.p,
				).toBe(MAIN);

				// One backup row per changed row, holding the original value.
				const backups = (
					await tx.execute(
						sql`SELECT source_table, row_id, phone FROM phone_extension_backup
						WHERE row_id IN (${sql.join(
							[
								seeded.ext,
								seeded.clean,
								seeded.uk,
								seeded.text,
								seeded.domestic1,
								seeded.none,
								guest?.id,
								helper?.id,
							].map((i) => sql`${i}::uuid`),
							sql`, `,
						)})`,
					)
				).rows as Array<{
					source_table: string;
					row_id: string;
					phone: string;
				}>;
				expect(backups.map((b) => b.source_table).sort()).toEqual([
					"club_charter_helpers",
					"guests",
					"people",
				]);
				for (const b of backups) expect(b.phone).toBe(WITH_EXT);
				expect(backups.find((b) => b.source_table === "people")?.row_id).toBe(
					seeded.ext,
				);

				// Idempotent: a second run changes nothing and adds no backup.
				for (const s of dataStatements()) await tx.execute(sql.raw(s));
				const again = (
					await tx.execute(
						sql`SELECT count(*)::int AS n FROM phone_extension_backup WHERE row_id = ${seeded.ext}::uuid`,
					)
				).rows[0] as { n: number };
				expect(again.n).toBe(1);
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

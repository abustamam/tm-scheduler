/**
 * One-off backfill: standardize existing stored phone numbers to E.164 (#295).
 *
 * Normalize-on-write (this PR) only touches NEW writes; this cleans the rows
 * already in the database so `toE164`'s read-time coalescing becomes a no-op
 * passthrough. Reuses the SAME pure `toStoredPhone` the write paths use, so the
 * backfill can never drift from them, and is idempotent (`toStoredPhone` of an
 * already-E.164 value is that value) — safe to re-run.
 *
 * - `members.phone` / `guests.phone`: normalized with THEIR club's default
 *   country code (a national number gains the club's code).
 * - `people.phone`: people are club-less (ADR-0008), so no single default
 *   applies — only already-international (`+…` / `00…`) numbers are reformatted;
 *   a bare national number is left as-is (it can't be made reliable without a
 *   country code, and read-time coalescing handles it per-club).
 *
 * Usage:
 *   bun run scripts/backfill-phone-e164.ts           # dry run (prints changes)
 *   bun run scripts/backfill-phone-e164.ts --apply   # write the changes
 *
 * Bun auto-loads .env.local for DATABASE_URL.
 */
import { eq, isNotNull } from "drizzle-orm";
import { db } from "#/db";
import { clubs, guests, members, people } from "#/db/schema";
import { toStoredPhone } from "#/lib/phone";

const APPLY = process.argv.includes("--apply");

/** host:port + db name from DATABASE_URL, password never included. */
function dbTarget(): string {
	const raw = process.env.DATABASE_URL;
	if (!raw) return "(DATABASE_URL unset)";
	try {
		const u = new URL(raw);
		const port = u.port ? `:${u.port}` : "";
		return `host=${u.hostname}${port} db=${u.pathname.replace(/^\//, "")}`;
	} catch {
		return "(unparseable DATABASE_URL)";
	}
}

async function main() {
	console.log(`Backfill phone → E.164 on ${dbTarget()}`);
	console.log(APPLY ? "MODE: apply (writing changes)" : "MODE: dry run\n");

	// Club default country codes, keyed by club id.
	const clubRows = await db
		.select({ id: clubs.id, cc: clubs.defaultCountryCode })
		.from(clubs);
	const clubCc = new Map(clubRows.map((c) => [c.id, c.cc]));

	let scanned = 0;
	let changed = 0;

	async function backfill(
		label: string,
		rows: { id: string; phone: string | null; clubId?: string }[],
		normalize: (row: { phone: string | null; clubId?: string }) => string | null,
		update: (id: string, next: string | null) => Promise<unknown>,
	) {
		for (const row of rows) {
			scanned++;
			const next = normalize(row);
			if (next === row.phone) continue;
			changed++;
			console.log(`  [${label}] ${row.id}: ${row.phone} → ${next}`);
			if (APPLY) await update(row.id, next);
		}
	}

	// members.phone — normalize with the member's club default.
	const memberRows = await db
		.select({ id: members.id, phone: members.phone, clubId: members.clubId })
		.from(members)
		.where(isNotNull(members.phone));
	await backfill(
		"member",
		memberRows,
		(r) => toStoredPhone(r.phone, clubCc.get(r.clubId ?? "") ?? null),
		(id, next) =>
			db.update(members).set({ phone: next }).where(eq(members.id, id)),
	);

	// guests.phone — normalize with the guest's club default.
	const guestRows = await db
		.select({ id: guests.id, phone: guests.phone, clubId: guests.clubId })
		.from(guests)
		.where(isNotNull(guests.phone));
	await backfill(
		"guest",
		guestRows,
		(r) => toStoredPhone(r.phone, clubCc.get(r.clubId ?? "") ?? null),
		(id, next) =>
			db.update(guests).set({ phone: next }).where(eq(guests.id, id)),
	);

	// people.phone — club-less; only reformat already-international numbers.
	const peopleRows = await db
		.select({ id: people.id, phone: people.phone })
		.from(people)
		.where(isNotNull(people.phone));
	await backfill(
		"person",
		peopleRows,
		(r) => toStoredPhone(r.phone, null),
		(id, next) =>
			db.update(people).set({ phone: next }).where(eq(people.id, id)),
	);

	console.log(
		`\n${APPLY ? "Applied" : "Would change"} ${changed} of ${scanned} rows with a phone.`,
	);
	if (!APPLY && changed > 0) {
		console.log("Re-run with --apply to write these changes.");
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});

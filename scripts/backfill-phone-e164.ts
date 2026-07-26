/**
 * One-off backfill: standardize existing stored phone numbers to E.164 (#295).
 *
 * Normalize-on-write only touches NEW writes; this cleans the rows already in
 * the database so `toE164`'s read-time coalescing becomes a no-op passthrough.
 * Reuses the SAME pure `toStoredPhone` the write paths use, so the backfill can
 * never drift from them, and is idempotent (`toStoredPhone` of an already-E.164
 * value is that value) — safe to re-run.
 *
 * RE-RUN THIS AFTER #397 (required, not hygiene). Phone is the dedup key for
 * guests and for the Person lookup in convert-to-member, and #397 gave the E.164
 * promotion a default country code so it ALWAYS applies. New writes for a club
 * with no country code set are now `+15551234567` where they used to be
 * `(555) 123-4567`; until the rows written before that are promoted too, the key
 * means different things for old and new rows — which is #397 itself, one level
 * up. A returning guest whose row predates the fix would get a duplicate.
 *
 * - `members.phone` / `guests.phone`: normalized with THEIR club's country code
 *   — the club's own setting, or `DEFAULT_COUNTRY_CODE` when it never set one
 *   (the same fallback `loadClubDefaultCountryCode` applies on write).
 * - `people.phone`: people are club-less (ADR-0008), so the app-wide
 *   `DEFAULT_COUNTRY_CODE` is what applies. Before #397 this pass left bare
 *   national numbers alone; it can't now, because the guest/member rows that
 *   convert-to-member dedups AGAINST are all E.164.
 *
 * The fallback is an assumption, and on a non-NANP club that never set a country
 * code it will be the wrong one. Check the dry-run output for `+1`-prefixed
 * numbers that don't belong to NANP clubs, and set those clubs' country code on
 * /admin/club-settings BEFORE applying.
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
import { DEFAULT_COUNTRY_CODE, toStoredPhone } from "#/lib/phone";

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

/**
 * Name the guest rows that #397 duplicated. Two rows for one visitor — one per
 * spelling of their phone — are invisible while the spellings normalize
 * differently; once they don't, they collide on the dedup key.
 *
 * This only REPORTS. Merging two visit histories is a judgment call (which name,
 * which stage) that belongs to the VP Membership, not a backfill: capture picks
 * the OLDEST matching row from here on, so the pipeline is consistent either way
 * — it just still shows two prospects until someone merges them. `applyUpdateGuest`
 * will also refuse to edit the newer row's phone while the collision stands.
 */
function reportGuestCollisions(
	rows: { id: string; name: string; phone: string | null; clubId: string }[],
	normalize: (row: { phone: string | null; clubId?: string }) => string | null,
): void {
	const byKey = new Map<string, { id: string; name: string }[]>();
	for (const row of rows) {
		const phone = normalize(row);
		if (!phone) continue;
		const key = `${row.clubId}|${phone}`;
		byKey.set(key, [...(byKey.get(key) ?? []), { id: row.id, name: row.name }]);
	}
	const collisions = [...byKey].filter(([, group]) => group.length > 1);
	if (collisions.length === 0) return;

	console.log(
		`\n${collisions.length} phone number(s) are shared by more than one guest in the same club —`,
	);
	console.log("the duplicate rows #397 created. Merge them by hand:");
	for (const [key, group] of collisions) {
		const [clubId, phone] = key.split("|");
		console.log(`  club ${clubId} · ${phone}`);
		for (const g of group) console.log(`    - ${g.name} (${g.id})`);
	}
}

async function main() {
	console.log(`Backfill phone → E.164 on ${dbTarget()}`);
	console.log(APPLY ? "MODE: apply (writing changes)" : "MODE: dry run\n");

	// Effective country code per club — the club's own, else the app default.
	// Mirrors `loadClubDefaultCountryCode`, so backfilled rows land exactly where
	// the write paths would put them.
	const clubRows = await db
		.select({ id: clubs.id, cc: clubs.defaultCountryCode })
		.from(clubs);
	const clubCc = new Map(
		clubRows.map((c) => [c.id, c.cc?.trim() || DEFAULT_COUNTRY_CODE]),
	);

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
		(r) =>
			toStoredPhone(r.phone, clubCc.get(r.clubId ?? "") ?? DEFAULT_COUNTRY_CODE),
		(id, next) =>
			db.update(members).set({ phone: next }).where(eq(members.id, id)),
	);

	// guests.phone — normalize with the guest's club default.
	const guestRows = await db
		.select({
			id: guests.id,
			name: guests.name,
			phone: guests.phone,
			clubId: guests.clubId,
		})
		.from(guests)
		.where(isNotNull(guests.phone));
	const guestPhone = (r: { phone: string | null; clubId?: string }) =>
		toStoredPhone(r.phone, clubCc.get(r.clubId ?? "") ?? DEFAULT_COUNTRY_CODE);
	await backfill("guest", guestRows, guestPhone, (id, next) =>
		db.update(guests).set({ phone: next }).where(eq(guests.id, id)),
	);

	// people.phone — club-less, so the app-wide default is the only code that
	// applies (#397). Convert-to-member dedups guests against these rows.
	const peopleRows = await db
		.select({ id: people.id, phone: people.phone })
		.from(people)
		.where(isNotNull(people.phone));
	await backfill(
		"person",
		peopleRows,
		(r) => toStoredPhone(r.phone, DEFAULT_COUNTRY_CODE),
		(id, next) =>
			db.update(people).set({ phone: next }).where(eq(people.id, id)),
	);

	console.log(
		`\n${APPLY ? "Applied" : "Would change"} ${changed} of ${scanned} rows with a phone.`,
	);
	if (!APPLY && changed > 0) {
		console.log("Re-run with --apply to write these changes.");
	}
	reportGuestCollisions(guestRows, guestPhone);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});

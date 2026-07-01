/**
 * One-off seed: import a Toastmasters club-membership CSV export into `members`.
 *
 * Usage:
 *   bun run scripts/import-members.ts --club <clubId> [--file <path>]
 *
 * - Imports only PaidMember rows.
 * - Two-pass match per club: email → exact name → insert; ambiguous names are
 *   skipped and warned.
 * - Overwrite policy: joinedAt/originalJoinDate always written; name/email/phone
 *   are fill-only (never overwrite a non-empty stored value). office is untouched.
 * Idempotent. Bun auto-loads .env.local for DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { members } from "#/db/schema";
import {
	chooseMatch,
	fillOnly,
	isPaid,
	mapRow,
	parseCsv,
} from "#/lib/members-csv";

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

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
	const clubId = arg("--club");
	const file = arg("--file") ?? "ref/Club-Membership20260630.csv";
	if (!clubId) {
		console.error("Missing --club <clubId>");
		process.exit(1);
	}

	const rows = parseCsv(readFileSync(file, "utf8"));
	const paid = rows.filter(isPaid);
	const skippedUnpaid = rows.length - paid.length;

	// Show the target DB before any write — eyeball host=localhost vs a prod
	// proxy host, and Ctrl-C if it's the wrong database.
	console.log(
		`Importing into ${dbTarget()} — ${paid.length} paid rows ` +
			`(${skippedUnpaid} unpaid skipped)\n`,
	);

	const existing = await db
		.select({
			id: members.id,
			email: members.email,
			name: members.name,
			phone: members.phone,
		})
		.from(members)
		.where(eq(members.clubId, clubId));

	let inserted = 0;
	let updatedEmail = 0;
	let updatedName = 0;
	let skippedAmbiguous = 0;

	for (const row of paid) {
		const m = mapRow(row);
		const match = chooseMatch(m, existing);

		if (match.kind === "ambiguous") {
			console.warn(`SKIP ambiguous name: ${m.name}`);
			skippedAmbiguous++;
			continue;
		}

		if (match.kind === "insert") {
			const [created] = await db
				.insert(members)
				.values({
					clubId,
					name: m.name,
					email: m.email,
					phone: m.phone,
					joinedAt: m.joinedAt,
					originalJoinDate: m.originalJoinDate,
				})
				.returning({ id: members.id });
			existing.push({
				id: created.id,
				email: m.email,
				name: m.name,
				phone: m.phone,
			});
			inserted++;
			console.log(`INSERT ${m.name}`);
			continue;
		}

		const current = existing.find((e) => e.id === match.id);
		if (!current) continue;
		await db
			.update(members)
			.set({
				name: fillOnly(current.name, m.name) ?? current.name,
				email: fillOnly(current.email, m.email),
				phone: fillOnly(current.phone, m.phone),
				joinedAt: m.joinedAt,
				originalJoinDate: m.originalJoinDate,
			})
			.where(eq(members.id, match.id));
		if (match.kind === "email") updatedEmail++;
		else updatedName++;
		console.log(`UPDATE (${match.kind}) ${m.name}`);
	}

	console.log(
		`\nDone. inserted=${inserted} updated-by-email=${updatedEmail} ` +
			`updated-by-name=${updatedName} skipped-ambiguous=${skippedAmbiguous} ` +
			`skipped-unpaid=${skippedUnpaid}`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

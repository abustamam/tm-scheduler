/**
 * One-off seed: import a Toastmasters club-membership CSV export into the
 * Person/Membership model (`people` + `members`) — ADR-0008 / #64.
 *
 * Usage:
 *   bun run scripts/import-members.ts --club <clubId> [--file <path>]
 *
 * - Imports only PaidMember rows.
 * - Resolves each row to a Person by precedence: Customer ID → unambiguous
 *   non-blank email → new person (never on name). Then upserts the per-club
 *   membership. Person-level facts (name/contact/original join date/Customer ID)
 *   live on `people`; the membership carries name/email/phone (fill-only) and
 *   joined_at.
 * Idempotent. Bun auto-loads .env.local for DATABASE_URL.
 */
import { readFileSync } from "node:fs";
import { isPaid, mapRow, parseCsv } from "#/lib/members-csv";
import { importPeopleAndMembers } from "#/server/import-members-logic";

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
	const mapped = paid.map(mapRow);

	// Show the target DB before any write — eyeball host=localhost vs a prod
	// proxy host, and Ctrl-C if it's the wrong database.
	console.log(
		`Importing into ${dbTarget()} — ${paid.length} paid rows ` +
			`(${skippedUnpaid} unpaid skipped)\n`,
	);

	const stats = await importPeopleAndMembers(clubId, mapped);

	console.log(
		`\nDone. people: created=${stats.peopleCreated} ` +
			`matched-by-customer-id=${stats.peopleMatchedByCustomerId} ` +
			`matched-by-email=${stats.peopleMatchedByEmail} ambiguous=${stats.ambiguous}\n` +
			`      members: created=${stats.membersCreated} updated=${stats.membersUpdated} ` +
			`skipped-blank-name=${stats.skippedBlankName} skipped-unpaid=${skippedUnpaid}`,
	);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

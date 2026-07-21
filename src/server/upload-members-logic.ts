/**
 * DB logic for the VPE-facing membership-CSV upload (#62). Kept out of the
 * `upload-members.ts` createServerFn module (this `-logic.ts` is never imported
 * by client routes) so `#/db` → `pg` → `Buffer` never leaks into the client
 * bundle — see `members-logic.ts` for the split rationale.
 *
 * Both entry points reuse the seed script's pure parse/map/filter helpers
 * (`members-csv.ts`) and the shared per-row decisions (`members-import-plan.ts`):
 *   - {@link previewMemberImport} dry-runs the batch (no writes) into the
 *     insert/update/skip diff the admin confirms.
 *   - {@link commitMemberImport} re-parses server-side (never trusts the client
 *     preview) and delegates the writes to the SAME `importPeopleAndMembers`
 *     the seed script uses, returning an audit summary.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { isPaid, mapRow, parseCsv } from "#/lib/members-csv";
import {
	type ExistingMembershipRow,
	type ExistingPersonRow,
	type ImportPlan,
	planImport,
} from "#/lib/members-import-plan";
import {
	type ImportStats,
	importPeopleAndMembers,
} from "./import-members-logic";

/** Columns the Toastmasters export always carries — a cheap sanity gate so a
 *  wrong file fails loudly instead of silently producing an empty import. */
const REQUIRED_COLUMNS = ["Status (*)", "Name"];

function parseAndValidate(csv: string): Record<string, string>[] {
	const rows = parseCsv(csv);
	if (rows.length === 0) {
		throw new Error("That file has no data rows — is it the CSV export?");
	}
	const columns = Object.keys(rows[0]);
	const missing = REQUIRED_COLUMNS.filter((c) => !columns.includes(c));
	if (missing.length > 0) {
		throw new Error(
			`This doesn't look like a Toastmasters membership export (missing column${
				missing.length > 1 ? "s" : ""
			}: ${missing.join(", ")}).`,
		);
	}
	return rows;
}

export interface ImportPreviewResult {
	/** Rows in the file (before the PaidMember filter). */
	totalRows: number;
	/** Rows that pass the PaidMember filter (the only ones imported). */
	paidRows: number;
	/** Non-PaidMember rows dropped by the filter. */
	unpaidSkipped: number;
	summary: ImportPlan["summary"];
	rows: ImportPlan["rows"];
}

/** Dry-run the upload into an insert/update/skip diff — NO writes. */
export async function previewMemberImport(
	clubId: string,
	csv: string,
): Promise<ImportPreviewResult> {
	const parsed = parseAndValidate(csv);
	const paid = parsed.filter(isPaid);
	const mapped = paid.map(mapRow);

	// People are global (club-less) — the resolver matches across every club, so
	// load them all, exactly as the committing writer does.
	const existingPeople: ExistingPersonRow[] = await db
		.select({
			id: people.id,
			customerId: people.customerId,
			email: people.email,
			name: people.name,
			phone: people.phone,
		})
		.from(people);
	const existingMemberships: ExistingMembershipRow[] = await db
		.select({
			id: members.id,
			personId: members.personId,
			name: members.name,
			email: members.email,
			phone: members.phone,
		})
		.from(members)
		.where(eq(members.clubId, clubId));

	const plan = planImport(existingPeople, existingMemberships, mapped);
	return {
		totalRows: parsed.length,
		paidRows: paid.length,
		unpaidSkipped: parsed.length - paid.length,
		summary: plan.summary,
		rows: plan.rows,
	};
}

export interface ImportCommitResult {
	stats: ImportStats;
	totalRows: number;
	paidRows: number;
	unpaidSkipped: number;
}

/** Commit the upload: re-parse server-side and run the shared writer. */
export async function commitMemberImport(
	clubId: string,
	csv: string,
): Promise<ImportCommitResult> {
	const parsed = parseAndValidate(csv);
	const paid = parsed.filter(isPaid);
	const mapped = paid.map(mapRow);
	const stats = await importPeopleAndMembers(clubId, mapped);
	return {
		stats,
		totalRows: parsed.length,
		paidRows: paid.length,
		unpaidSkipped: parsed.length - paid.length,
	};
}

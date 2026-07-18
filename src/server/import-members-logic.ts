/**
 * DB logic for importing a Toastmasters club-membership CSV into the
 * Person/Membership model (ADR-0008 / #64). Kept out of any createServerFn
 * module (this is a `-logic.ts`, never imported by client routes) so `#/db`
 * never leaks into the client bundle; `scripts/import-members.ts` is the runner.
 *
 * Per row, resolve the Person by ADR-0008 precedence (Customer ID → unambiguous
 * non-blank email → new person), then upsert the Membership for (club, person).
 * People are global (club-less); memberships are the per-club roster row.
 */
import { and, eq } from "drizzle-orm";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { batchSharedEmails, type MappedMember } from "#/lib/members-csv";
import {
	classifyMembership,
	type ExistingPersonRow,
	resolvePersonDecision,
} from "#/lib/members-import-plan";
import {
	currentOfficersFor,
	openOfficerTermIfAbsent,
} from "./officer-terms-logic";

export interface ImportStats {
	peopleCreated: number;
	peopleMatchedByCustomerId: number;
	peopleMatchedByEmail: number;
	membersCreated: number;
	membersUpdated: number;
	/** Rows whose email was shared by 2+ people — created as a new person. */
	ambiguous: number;
	/** Rows skipped because the CSV name was blank. */
	skippedBlankName: number;
	/** Rows whose "Current Position" was non-blank but unparseable (left null,
	 *  logged as a warning — like the ambiguous-name skip). */
	unparseablePosition: number;
}

/**
 * Import mapped CSV rows into `people` + `members` for one club. Returns counts.
 * People-level facts (canonical name/contact, original join date, Customer ID)
 * land on `people`; the per-club membership carries name/email/phone (fill-only)
 * and `joined_at`.
 *
 * The per-row verdicts (which Person a row resolves to, insert vs. fill-only
 * update of the membership) come from the shared pure decisions in
 * `members-import-plan.ts` — the SAME code the pre-commit preview runs — so the
 * VPE's diff can never drift from what this writer actually does.
 */
export async function importPeopleAndMembers(
	clubId: string,
	rows: MappedMember[],
): Promise<ImportStats> {
	// Load all people once; keep the in-memory list in sync as we insert so
	// duplicate rows within a single run resolve against freshly-created people.
	const existing: ExistingPersonRow[] = await db
		.select({
			id: people.id,
			customerId: people.customerId,
			email: people.email,
			name: people.name,
			phone: people.phone,
		})
		.from(people);

	const stats: ImportStats = {
		peopleCreated: 0,
		peopleMatchedByCustomerId: 0,
		peopleMatchedByEmail: 0,
		membersCreated: 0,
		membersUpdated: 0,
		ambiguous: 0,
		skippedBlankName: 0,
		unparseablePosition: 0,
	};

	// Emails shared by 2+ distinct names within this batch must never merge —
	// force each such row to a distinct person (mirrors the backfill's scan).
	const sharedEmails = batchSharedEmails(rows);

	for (const row of rows) {
		if (!row.name) {
			stats.skippedBlankName++;
			continue;
		}

		// A non-blank "Current Position" the parser couldn't map stays null and is
		// logged (mirrors the ambiguous-name skip). In-app editing is the source of
		// truth, so a warning is enough — we never guess an office.
		if (row.currentPosition && !row.officerPosition) {
			stats.unparseablePosition++;
			console.warn(
				`SKIP unparseable office "${row.currentPosition}" for ${row.name} — leaving officer_position null`,
			);
		}

		// Which Person does this row resolve to? Shared code with the preview.
		const pd = resolvePersonDecision(row, existing, sharedEmails);

		let personId: string;
		if (pd.kind === "customerId" || pd.kind === "email") {
			const current = existing.find((p) => p.id === pd.id);
			if (!current) continue; // unreachable — match ids come from `existing`
			personId = current.id;
			if (pd.kind === "customerId") stats.peopleMatchedByCustomerId++;
			else stats.peopleMatchedByEmail++;

			// Person-level fill-only name/email/phone; adopt a Customer ID when we
			// finally have one; always refresh the original join date from the CSV.
			await db.update(people).set(pd.set).where(eq(people.id, personId));
			current.customerId = pd.set.customerId;
			current.name = pd.set.name;
			current.email = pd.set.email;
			current.phone = pd.set.phone;
		} else {
			if (pd.kind === "ambiguous") stats.ambiguous++;
			const [created] = await db
				.insert(people)
				.values(pd.values)
				.returning({ id: people.id });
			if (!created) throw new Error("Failed to insert person");
			personId = created.id;
			existing.push({
				id: personId,
				customerId: pd.values.customerId,
				email: pd.values.email,
				name: pd.values.name,
				phone: pd.values.phone,
			});
			stats.peopleCreated++;
		}

		// Membership: one row per (club, person). Fill-only name/email/phone so an
		// in-app edit is never clobbered; joined_at is per-club and always set.
		const [existingMember] = await db
			.select({
				id: members.id,
				name: members.name,
				email: members.email,
				phone: members.phone,
			})
			.from(members)
			.where(and(eq(members.clubId, clubId), eq(members.personId, personId)))
			.limit(1);

		const md = classifyMembership(row, existingMember);
		let membershipId: string;
		if (md.kind === "update" && existingMember) {
			await db
				.update(members)
				.set(md.set)
				.where(eq(members.id, existingMember.id));
			membershipId = existingMember.id;
			stats.membersUpdated++;
		} else if (md.kind === "insert") {
			const [created] = await db
				.insert(members)
				.values({ clubId, personId, ...md.values })
				.returning({ id: members.id });
			if (!created) throw new Error("Failed to insert member");
			membershipId = created.id;
			stats.membersCreated++;
		} else {
			continue; // unreachable — update ⟺ existingMember present
		}

		// Officer term (#100): the CSV's current position opens a term ONLY when
		// the membership currently holds NO office — never overwriting or adding to
		// an in-app assignment (the source of truth). termStart is unknown from the
		// export (null). Idempotent across reruns.
		if (row.officerPosition) {
			const open = await currentOfficersFor(membershipId);
			if (open.length === 0) {
				await openOfficerTermIfAbsent(
					db,
					membershipId,
					row.officerPosition,
					null,
				);
			}
		}
	}

	return stats;
}

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
import {
	batchSharedEmails,
	type ExistingPerson,
	fillOnly,
	type MappedMember,
	resolvePerson,
} from "#/lib/members-csv";
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

interface PersonState extends ExistingPerson {
	name: string;
	phone: string | null;
}

/**
 * Import mapped CSV rows into `people` + `members` for one club. Returns counts.
 * People-level facts (canonical name/contact, original join date, Customer ID)
 * land on `people`; the per-club membership carries name/email/phone (fill-only)
 * and `joined_at`.
 */
export async function importPeopleAndMembers(
	clubId: string,
	rows: MappedMember[],
): Promise<ImportStats> {
	// Load all people once; keep the in-memory list in sync as we insert so
	// duplicate rows within a single run resolve against freshly-created people.
	const existing: PersonState[] = await db
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

		const emailNorm = (row.email ?? "").trim().toLowerCase();
		const match =
			emailNorm !== "" && sharedEmails.has(emailNorm)
				? ({ kind: "ambiguous" } as const)
				: resolvePerson(
						{ customerId: row.customerId, email: row.email },
						existing,
					);

		let personId: string;
		if (match.kind === "customerId" || match.kind === "email") {
			const current = existing.find((p) => p.id === match.id);
			if (!current) continue; // unreachable — match ids come from `existing`
			personId = current.id;
			if (match.kind === "customerId") stats.peopleMatchedByCustomerId++;
			else stats.peopleMatchedByEmail++;

			// Person-level: fill-only name/email/phone; adopt a Customer ID when we
			// finally have one; always refresh the original join date from the CSV.
			const nextCustomerId = current.customerId ?? row.customerId;
			const nextName = fillOnly(current.name, row.name) ?? current.name;
			const nextEmail = fillOnly(current.email, row.email);
			const nextPhone = fillOnly(current.phone, row.phone);
			await db
				.update(people)
				.set({
					customerId: nextCustomerId,
					name: nextName,
					email: nextEmail,
					phone: nextPhone,
					originalJoinDate: row.originalJoinDate,
				})
				.where(eq(people.id, personId));
			current.customerId = nextCustomerId;
			current.name = nextName;
			current.email = nextEmail;
			current.phone = nextPhone;
		} else {
			if (match.kind === "ambiguous") stats.ambiguous++;
			const [created] = await db
				.insert(people)
				.values({
					customerId: row.customerId,
					name: row.name,
					email: row.email,
					phone: row.phone,
					originalJoinDate: row.originalJoinDate,
				})
				.returning({ id: people.id });
			if (!created) throw new Error("Failed to insert person");
			personId = created.id;
			existing.push({
				id: personId,
				customerId: row.customerId,
				email: row.email,
				name: row.name,
				phone: row.phone,
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

		let membershipId: string;
		if (existingMember) {
			await db
				.update(members)
				.set({
					name: fillOnly(existingMember.name, row.name) ?? existingMember.name,
					email: fillOnly(existingMember.email, row.email),
					phone: fillOnly(existingMember.phone, row.phone),
					joinedAt: row.joinedAt,
				})
				.where(eq(members.id, existingMember.id));
			membershipId = existingMember.id;
			stats.membersUpdated++;
		} else {
			const [created] = await db
				.insert(members)
				.values({
					clubId,
					personId,
					name: row.name,
					email: row.email,
					phone: row.phone,
					joinedAt: row.joinedAt,
				})
				.returning({ id: members.id });
			if (!created) throw new Error("Failed to insert member");
			membershipId = created.id;
			stats.membersCreated++;
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

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
import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { batchSharedEmails, type MappedMember } from "#/lib/members-csv";
import {
	classifyMembership,
	type ExistingPersonRow,
	resolvePersonDecision,
} from "#/lib/members-import-plan";
import { toStoredPhone } from "#/lib/phone";
import { loadClubDefaultCountryCode } from "./clubs-logic";
export type ImportConnection =
	| typeof db
	| Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ImportWrite = (
	kind: "person" | "member",
	rowIndex: number,
	id: string | null,
	work: (conn: ImportConnection) => Promise<{ id: string }[]>,
) => Promise<{ id: string }[]>;

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
	/** Parsed assignments not applied: roster import never grants access. */
	skippedOfficerAssignments: number;
}

/**
 * The Person rows an import resolves against, for `clubId`. **Shared by the
 * committing writer below AND by the dry-run preview** (`upload-members-logic`)
 * — they run the same pure decisions over this list, so loading it differently
 * on the two sides is the one way the VPE's approved diff can stop matching what
 * actually runs. It lives here, in one exported function, for that reason.
 *
 * The match address is `people.email` FALLING BACK to this club's own roster
 * address (#756). `people.email` is the verified identity address now and is
 * NULL for everyone who has not signed in — migration 0076 cleared the rest — so
 * a person-level-only list stops recognising a member who has no Customer ID.
 * The miss is not quiet: it adds a second Person AND a second roster row for the
 * same human, on every subsequent import.
 *
 * The fallback is scoped to the IMPORTING club by the join condition,
 * deliberately. A contact record another club typed must not be reachable from
 * this CSV — that is the cross-club shape the rest of #756 closes. Person-level
 * addresses stay global, as they always were.
 */
export async function loadPersonCandidates(
	clubId: string,
	conn: ImportConnection = db,
): Promise<ExistingPersonRow[]> {
	// Plain `select`, not `selectDistinct`: the join cannot fan out, so the DISTINCT
	// would be a HashAggregate over the whole `people` table for nothing.
	// `members_club_person_unique` guarantees at most one membership per
	// (club, person), and `people.id` is in the projection anyway.
	return conn
		.select({
			id: people.id,
			customerId: people.customerId,
			email: sql<string | null>`coalesce(${people.email}, ${members.email})`,
			name: people.name,
			phone: people.phone,
		})
		.from(people)
		.leftJoin(
			members,
			and(eq(members.personId, people.id), eq(members.clubId, clubId)),
		);
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
	rawRows: MappedMember[],
	options: {
		conn?: ImportConnection;
		onResolved?: (
			rowIndex: number,
			membershipId: string,
			personId: string,
		) => void;
		write?: ImportWrite;
		countryCode?: string;
	} = {},
): Promise<ImportStats> {
	// Standardize every imported phone to E.164 on write (#295) with the club's
	// default country code, before the shared planner decides person/membership
	// fills — so both the CLI runner and the VPE upload commit store E.164.
	const conn = options.conn ?? db;
	const write: ImportWrite =
		options.write ?? ((_kind, _rowIndex, _id, work) => work(conn));
	const cc = options.countryCode ?? (await loadClubDefaultCountryCode(clubId));
	const rows: MappedMember[] = rawRows.map((r) => ({
		...r,
		phone: toStoredPhone(r.phone, cc),
	}));

	// Load all people once; keep the in-memory list in sync as we insert so
	// duplicate rows within a single run resolve against freshly-created people.
	const existing = await loadPersonCandidates(clubId, conn);

	const stats: ImportStats = {
		peopleCreated: 0,
		peopleMatchedByCustomerId: 0,
		peopleMatchedByEmail: 0,
		membersCreated: 0,
		membersUpdated: 0,
		ambiguous: 0,
		skippedBlankName: 0,
		unparseablePosition: 0,
		skippedOfficerAssignments: 0,
	};

	// Emails shared by 2+ distinct names within this batch must never merge —
	// force each such row to a distinct person (mirrors the backfill's scan).
	const sharedEmails = batchSharedEmails(rows);

	for (const [rowIndex, row] of rows.entries()) {
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

			// Person-level fill-only name/phone; adopt a Customer ID when we finally
			// have one; always refresh the original join date from the CSV.
			//
			// `email` is absent from `MatchedPersonValues` by TYPE (#756), not by a
			// destructure here — a destructure left the shared PLANNER still
			// computing the field and mirroring it into its own candidate list, so
			// the preview and this writer disagreed inside one batch. Matching on
			// Customer ID or on a person-level address is GLOBAL, so this row can
			// resolve to a Person another club holds — and a CSV is a file an officer
			// uploaded, not an address anyone proved they own. The address fills the
			// MEMBERSHIP's contact record below instead, which is the column the
			// invite and the claim both read. A Person CREATED by this import still
			// carries it (the `insert` arm below): a fresh row is nobody's identity
			// yet, and `people.email` remains the dedupe key ADR-0008 leans on.
			// Spelled out field by field rather than `.set(pd.set)`. A SET whose
			// argument is an identifier cannot be checked by scanning, so
			// `person-email-writers.guard.test.ts` refuses one outright — and it is
			// right to: this call site read `.set(pdRest)` when the field was merely
			// destructured away, and putting `email` back into that object would
			// have restored the removed cross-club writer with every gate green.
			await write("person", rowIndex, personId, async (conn) =>
				conn
					.update(people)
					.set({
						customerId: pd.set.customerId,
						name: pd.set.name,
						phone: pd.set.phone,
						originalJoinDate: pd.set.originalJoinDate,
					})
					.where(eq(people.id, personId))
					.returning({ id: people.id }),
			);
			current.customerId = pd.set.customerId;
			current.name = pd.set.name;
			current.phone = pd.set.phone;
		} else {
			if (pd.kind === "ambiguous") stats.ambiguous++;
			const [created] = await write("person", rowIndex, null, async (conn) =>
				conn.insert(people).values(pd.values).returning({ id: people.id }),
			);
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
		const [existingMember] = await conn
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
			await write("member", rowIndex, existingMember.id, async (conn) =>
				conn
					.update(members)
					.set(md.set)
					.where(eq(members.id, existingMember.id))
					.returning({ id: members.id }),
			);
			membershipId = existingMember.id;
			stats.membersUpdated++;
		} else if (md.kind === "insert") {
			// CLI imports use the bare `db` handle, so the
			// SELECT above and this INSERT are separated by an arbitrary gap — two
			// admins importing overlapping rosters is the widest window in the app
			// for a double-add. The unique index (#489) closes it; DO NOTHING plus a
			// re-read turns losing that race into a no-op update instead of a 500
			// that strands the import partway through a file.
			const [created] = await write("member", rowIndex, null, async (conn) =>
				conn
					.insert(members)
					.values({ clubId, personId, ...md.values })
					.onConflictDoNothing({ target: [members.clubId, members.personId] })
					.returning({ id: members.id }),
			);
			if (created) {
				membershipId = created.id;
				stats.membersCreated++;
			} else {
				// Lost the race. Reconcile against the winner's row exactly as the
				// non-raced branch above would — re-classifying is the whole point.
				// Taking only the id would silently drop this CSV row's name/email/
				// phone while still reporting the member as "updated", and the
				// overlapping-import case this branch exists for is precisely when
				// the two admins' files do NOT carry identical data.
				const [raced] = await conn
					.select({
						id: members.id,
						name: members.name,
						email: members.email,
						phone: members.phone,
					})
					.from(members)
					.where(
						and(eq(members.clubId, clubId), eq(members.personId, personId)),
					)
					.limit(1);
				if (!raced) throw new Error("Failed to insert member");
				const racedMd = classifyMembership(row, raced);
				if (racedMd.kind === "update") {
					await write("member", rowIndex, raced.id, async (conn) =>
						conn
							.update(members)
							.set(racedMd.set)
							.where(eq(members.id, raced.id))
							.returning({ id: members.id }),
					);
				}
				membershipId = raced.id;
				stats.membersUpdated++;
			}
		} else {
			continue; // unreachable — update ⟺ existingMember present
		}

		if (row.officerPosition) stats.skippedOfficerAssignments++;
		options.onResolved?.(rowIndex, membershipId, personId);
	}

	return stats;
}

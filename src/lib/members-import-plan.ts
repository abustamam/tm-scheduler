/**
 * Pure planning layer for the Toastmasters membership CSV import — no DB access.
 *
 * The two per-row decisions the importer makes are extracted here as pure
 * functions so that BOTH the committing writer (`import-members-logic.ts`, used
 * by the seed script AND the VPE upload) and the read-only preview
 * (`upload-members-logic.ts`) reach the identical verdict from the same code:
 *
 *   - {@link resolvePersonDecision} — which Person a row resolves to
 *     (Customer ID → unambiguous email → new/ambiguous), plus the fill-only
 *     values to write.
 *   - {@link classifyMembership} — insert vs. fill-only update of the per-club
 *     membership row, and which contact fields the update actually fills.
 *
 * {@link planImport} runs those two decisions over a whole batch WITHOUT
 * touching the DB, producing the insert/update/skip diff the VPE confirms before
 * commit. It mirrors the writer's sequential in-memory bookkeeping (a person
 * created by an earlier row is visible to a later one) so the preview counts
 * match what the commit will do — a property locked by an integration test.
 */
import {
	batchSharedEmails,
	fillOnly,
	type MappedMember,
	resolvePerson,
} from "#/lib/members-csv";

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const isBlank = (s: string | null | undefined) => norm(s) === "";

/** An existing Person, as the resolver sees it (people are global, club-less). */
export interface ExistingPersonRow {
	id: string;
	customerId: string | null;
	email: string | null;
	name: string;
	phone: string | null;
}

/** An existing per-club membership row (the roster row a row may update). */
export interface ExistingMembershipRow {
	id: string;
	personId: string;
	name: string;
	email: string | null;
	phone: string | null;
}

/** Person-row column values written on insert / fill-only update. */
export interface PersonValues {
	customerId: string | null;
	name: string;
	email: string | null;
	phone: string | null;
	originalJoinDate: Date | null;
}

/**
 * How one CSV row resolves against the existing people. `customerId`/`email`
 * are matches (carry the target person `id` and the fill-only `set` to write);
 * `insert`/`ambiguous` create a new person (`ambiguous` = the row's email is
 * shared by 2+ distinct people this batch, so it is deliberately NOT merged).
 */
export type PersonDecision =
	| { kind: "customerId"; id: string; set: PersonValues }
	| { kind: "email"; id: string; set: PersonValues }
	| { kind: "insert"; values: PersonValues }
	| { kind: "ambiguous"; values: PersonValues };

/**
 * Decide a row's Person, mirroring `importPeopleAndMembers` exactly:
 * a shared-email row is forced ambiguous up front, otherwise ADR-0008
 * precedence (Customer ID → unambiguous email → insert) applies. On a match the
 * `set` is fill-only for name/email/phone and always adopts a Customer ID /
 * refreshes the original join date.
 */
export function resolvePersonDecision(
	row: MappedMember,
	existing: ExistingPersonRow[],
	sharedEmails: Set<string>,
): PersonDecision {
	const emailNorm = norm(row.email);
	const match =
		emailNorm !== "" && sharedEmails.has(emailNorm)
			? ({ kind: "ambiguous" } as const)
			: resolvePerson(
					{ customerId: row.customerId, email: row.email },
					existing,
				);

	if (match.kind === "customerId" || match.kind === "email") {
		const current = existing.find((p) => p.id === match.id);
		// Unreachable — match ids always come from `existing`; fall back to insert.
		if (!current) {
			return { kind: "insert", values: personValues(row) };
		}
		const set: PersonValues = {
			customerId: current.customerId ?? row.customerId,
			name: fillOnly(current.name, row.name) ?? current.name,
			email: fillOnly(current.email, row.email),
			phone: fillOnly(current.phone, row.phone),
			originalJoinDate: row.originalJoinDate,
		};
		return match.kind === "customerId"
			? { kind: "customerId", id: current.id, set }
			: { kind: "email", id: current.id, set };
	}

	return match.kind === "ambiguous"
		? { kind: "ambiguous", values: personValues(row) }
		: { kind: "insert", values: personValues(row) };
}

function personValues(row: MappedMember): PersonValues {
	return {
		customerId: row.customerId,
		name: row.name,
		email: row.email,
		phone: row.phone,
		originalJoinDate: row.originalJoinDate,
	};
}

/** A contact field the fill-only update populates (was empty, now filled). */
export interface FieldFill {
	field: "name" | "email" | "phone";
	to: string;
}

/** Membership-row column values written on insert / fill-only update. */
export interface MembershipValues {
	name: string;
	email: string | null;
	phone: string | null;
	joinedAt: Date | null;
}

/**
 * Insert a fresh membership, or fill-only update the existing one. `fills` lists
 * the contact fields the update actually populates (existing was empty) so the
 * preview can say exactly what changes; `joinedAt` is always (re)written and is
 * reported separately.
 */
export type MembershipDecision =
	| { kind: "insert"; values: MembershipValues }
	| { kind: "update"; set: MembershipValues; fills: FieldFill[] };

/** Classify the per-club membership for a row (insert vs. fill-only update). */
export function classifyMembership(
	row: MappedMember,
	existing: Pick<ExistingMembershipRow, "name" | "email" | "phone"> | undefined,
): MembershipDecision {
	if (!existing) {
		return {
			kind: "insert",
			values: {
				name: row.name,
				email: row.email,
				phone: row.phone,
				joinedAt: row.joinedAt,
			},
		};
	}

	const fills: FieldFill[] = [];
	if (isBlank(existing.name) && !isBlank(row.name)) {
		fills.push({ field: "name", to: row.name });
	}
	if (isBlank(existing.email) && !isBlank(row.email) && row.email) {
		fills.push({ field: "email", to: row.email });
	}
	if (isBlank(existing.phone) && !isBlank(row.phone) && row.phone) {
		fills.push({ field: "phone", to: row.phone });
	}

	return {
		kind: "update",
		set: {
			name: fillOnly(existing.name, row.name) ?? existing.name,
			email: fillOnly(existing.email, row.email),
			phone: fillOnly(existing.phone, row.phone),
			joinedAt: row.joinedAt,
		},
		fills,
	};
}

/** A single roster row of the pre-commit diff, safe to send to the client. */
export interface PreviewRow {
	name: string;
	email: string | null;
	phone: string | null;
	/** Club join date the row would set, ISO-8601, or null. */
	joinedAt: string | null;
	action: "insert" | "update" | "skip";
	/** Plain-language note (what fills, why skipped, shared-email warning). */
	note: string | null;
}

/** Aggregate counts backing the preview summary and post-commit audit. */
export interface PlanSummary {
	/** New roster memberships that would be created. */
	toInsert: number;
	/** Existing memberships that would be fill-only updated. */
	toUpdate: number;
	/** Rows skipped (blank name). */
	toSkip: number;
	/** New Person records created (a subset drives `toInsert`). */
	peopleCreated: number;
	/** Rows matched to an existing Person (Customer ID or email). */
	peopleMatched: number;
	/** Rows whose email is shared by 2+ people — created as a distinct person. */
	ambiguous: number;
	/** Rows with a non-blank Current Position the parser couldn't map. */
	unparseablePositions: number;
}

export interface ImportPlan {
	summary: PlanSummary;
	rows: PreviewRow[];
}

function isoOrNull(d: Date | null): string | null {
	return d ? d.toISOString() : null;
}

function updateNote(fills: FieldFill[], joinedAt: Date | null): string {
	const parts: string[] = [];
	if (fills.length > 0) {
		parts.push(`Fills ${fills.map((f) => f.field).join(", ")}`);
	}
	if (joinedAt) parts.push("Sets join date");
	return parts.length > 0 ? parts.join(" · ") : "No changes";
}

/**
 * Dry-run the whole import over the current people + this club's memberships,
 * producing the insert/update/skip diff without any DB write. Rows are processed
 * in order and the in-memory people list / membership map grow as we go, so the
 * plan reflects within-batch resolution exactly as the committing writer does.
 */
export function planImport(
	existingPeople: ExistingPersonRow[],
	existingMemberships: ExistingMembershipRow[],
	rows: MappedMember[],
): ImportPlan {
	const people = existingPeople.map((p) => ({ ...p }));
	const membershipByPerson = new Map<string, ExistingMembershipRow>();
	for (const m of existingMemberships) membershipByPerson.set(m.personId, m);
	const sharedEmails = batchSharedEmails(rows);

	const summary: PlanSummary = {
		toInsert: 0,
		toUpdate: 0,
		toSkip: 0,
		peopleCreated: 0,
		peopleMatched: 0,
		ambiguous: 0,
		unparseablePositions: 0,
	};
	const previewRows: PreviewRow[] = [];
	let synthCounter = 0;

	for (const row of rows) {
		if (!row.name) {
			summary.toSkip++;
			previewRows.push({
				name: row.name,
				email: row.email,
				phone: row.phone,
				joinedAt: isoOrNull(row.joinedAt),
				action: "skip",
				note: "Blank name — skipped",
			});
			continue;
		}

		if (row.currentPosition && !row.officerPosition) {
			summary.unparseablePositions++;
		}

		const pd = resolvePersonDecision(row, people, sharedEmails);
		let personId: string;
		if (pd.kind === "customerId" || pd.kind === "email") {
			const current = people.find((p) => p.id === pd.id);
			if (!current) continue; // unreachable
			personId = current.id;
			summary.peopleMatched++;
			current.customerId = pd.set.customerId;
			current.name = pd.set.name;
			current.email = pd.set.email;
			current.phone = pd.set.phone;
		} else {
			personId = `__new_person_${synthCounter++}`;
			summary.peopleCreated++;
			if (pd.kind === "ambiguous") summary.ambiguous++;
			people.push({
				id: personId,
				customerId: pd.values.customerId,
				email: pd.values.email,
				name: pd.values.name,
				phone: pd.values.phone,
			});
		}

		const existingMember = membershipByPerson.get(personId);
		const md = classifyMembership(row, existingMember);
		if (md.kind === "update" && existingMember) {
			summary.toUpdate++;
			previewRows.push({
				name: row.name,
				email: row.email,
				phone: row.phone,
				joinedAt: isoOrNull(row.joinedAt),
				action: "update",
				note: updateNote(md.fills, row.joinedAt),
			});
			// Mirror the fill-only write so a later same-person row sees it.
			membershipByPerson.set(personId, {
				...existingMember,
				name: md.set.name,
				email: md.set.email,
				phone: md.set.phone,
			});
		} else if (md.kind === "insert") {
			summary.toInsert++;
			previewRows.push({
				name: row.name,
				email: row.email,
				phone: row.phone,
				joinedAt: isoOrNull(row.joinedAt),
				action: "insert",
				note:
					pd.kind === "ambiguous"
						? "New — shares an email with another member; added separately"
						: null,
			});
			membershipByPerson.set(personId, {
				id: `__new_member_${personId}`,
				personId,
				name: md.values.name,
				email: md.values.email,
				phone: md.values.phone,
			});
		}
	}

	return { summary, rows: previewRows };
}

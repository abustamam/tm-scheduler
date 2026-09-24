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

/**
 * An existing Person, as the resolver sees it.
 *
 * People are global and club-less, but `email` here is NOT simply
 * `people.email`: since #756 the loader (`loadPersonCandidates`) supplies the
 * person-level address falling back to THIS club's roster address, because
 * migration 0076 nulled the person-level one for everyone who has never signed
 * in. Both sides of the import — the committing writer and the dry-run preview —
 * must build this list through that same function, or the diff the VPE approves
 * stops matching what runs.
 */
export interface ExistingPersonRow {
	id: string;
	customerId: string | null;
	email: string | null;
	name: string;
	phone: string | null;
	/**
	 * Which clubs hold this Person, relative to the importing one (#759).
	 *
	 * - `this_club` — a roster row exists for (importing club, person), ANY
	 *   status. No status filter: the bind rule counts every membership, and
	 *   every scar in this area (#755, #756) came from narrowing a set that
	 *   should not have been narrowed.
	 * - `other_club_only` — held by at least one other club and not by this one.
	 *   A match onto such a Person is REFUSED ({@link PersonDecision} `foreign`):
	 *   attaching it would give them a second club, `rosterPermitsBind` refuses
	 *   a Person two clubs hold, and so the import would stop a stranger signing
	 *   in from a club neither they nor their officers can see.
	 * - `released_by_this_club` — no memberships anywhere, and the LATEST
	 *   `member_remove` naming this Person (`detail.personId`) is in the
	 *   importing club (#855). Matchable, which keeps remove-then-reimport
	 *   working for the club that did the removing. The latest, not any: a
	 *   Person removed by A, re-added by B and removed by B is B's alone.
	 *
	 *   This is what makes the concurrent-import race safe, and it is the ONLY
	 *   thing that does. The attach is still decided from the snapshot
	 *   `loadPersonCandidates` took at the start of the file, and the writer
	 *   has no transaction: the membership insert is `onConflictDoNothing` on
	 *   (club, person), which merges two writers in the SAME club and does
	 *   nothing about two DIFFERENT clubs. Two clubs importing one orphan at
	 *   once, if both could match, would each see an unheld Person, each
	 *   insert, and leave them held by two clubs, which no bind can recover.
	 *   That cannot happen here because at most one club can ever match an
	 *   orphan: the latest removal names exactly one club. Any new path that
	 *   attaches an EXISTING Person no club holds (another importer, a convert
	 *   arm, a restore) reopens the race unless it is held to the same
	 *   single-club rule or serialised.
	 * - `nobody` — no memberships anywhere and no such removal record. REFUSED
	 *   like `other_club_only` (#855). An orphan keeps its person-scoped history
	 *   (speeches, Pathways), and the roster row an import would mint is then the
	 *   only membership that can vouch for a bind — carrying whatever address
	 *   the importing club typed. Refusing writes nothing, so it cannot collide
	 *   with `people_customer_id_unique` either.
	 *
	 *   Orphans with no removal record, and so refused by every club: Persons
	 *   whose club was deleted (the cascade writes no `member_remove`, and takes
	 *   the club's activity log with it), Persons left by a guest-convert undo
	 *   (its `member_remove` carries no `personId`), Persons absorbed by a
	 *   member merge, and anyone removed before #855 recorded `personId`. All
	 *   conservative: re-adding them is a deliberate act, not a file.
	 *
	 * A Person created earlier in the SAME batch is `this_club`, truthfully: its
	 * membership in the importing club is inserted immediately after it.
	 */
	heldBy: "this_club" | "released_by_this_club" | "other_club_only" | "nobody";
	/** `people.user_id` is set — bound to an account, so nothing a CSV writes
	 *  to a roster row can change their sign-in. */
	linked: boolean;
}

/** An existing per-club membership row (the roster row a row may update). */
export interface ExistingMembershipRow {
	id: string;
	personId: string;
	name: string;
	email: string | null;
	phone: string | null;
}

/**
 * Person-row column values written on INSERT.
 *
 * `email` is on this type because Person CREATION still carries it — a brand-new
 * row is nobody's identity yet, and `people.email` remains ADR-0008's fallback
 * dedupe key. A MATCH does not: see {@link MatchedPersonValues}.
 */
export interface PersonValues {
	customerId: string | null;
	name: string;
	email: string | null;
	phone: string | null;
	originalJoinDate: Date | null;
}

/**
 * What a MATCH writes to the Person row — everything `PersonValues` carries
 * except `email` (#756).
 *
 * The omission is the type doing a job a comment was doing badly. A CSV is a
 * file an officer uploaded, so it may not re-key an existing human's identity;
 * the committing writer therefore stopped writing the column on a match. It
 * expressed that by destructuring the field away, which left the PLANNER still
 * computing it and still mirroring it into its in-memory candidate list — so the
 * preview and the commit disagreed inside a single batch, and a row that matched
 * in the diff the VPE approved minted a duplicate Person and a duplicate roster
 * row on commit. Narrowing the type makes that shape unrepresentable.
 */
export type MatchedPersonValues = Omit<PersonValues, "email">;

/** The `heldBy` values a CSV row may match onto; every other one is `foreign`. */
const ATTACHABLE: ReadonlySet<ExistingPersonRow["heldBy"]> = new Set([
	"this_club",
	"released_by_this_club",
]);

/**
 * How one CSV row resolves against the existing people. `customerId`/`email`
 * are matches (carry the target person `id` and the fill-only `set` to write);
 * `insert`/`ambiguous` create a new person (`ambiguous` = the row's email is
 * shared by 2+ distinct people this batch, so it is deliberately NOT merged).
 */
export type PersonDecision =
	| { kind: "customerId"; id: string; set: MatchedPersonValues }
	| { kind: "email"; id: string; set: MatchedPersonValues }
	| { kind: "insert"; values: PersonValues }
	| { kind: "ambiguous"; values: PersonValues }
	/**
	 * The row matched a Person only ANOTHER club holds (#759), or one NO club
	 * holds that the importing club did not last remove (#855). Skipped outright
	 * — no Person insert, no membership, no officer term — and counted.
	 *
	 * Not "mint a fresh Person instead": `people.customer_id` is UNIQUE, so a
	 * fresh row keeping the Customer ID throws mid-file (the writer runs with no
	 * transaction), and one dropping it matches nothing next time and mints
	 * another Person and roster row on every import, without bound.
	 */
	| { kind: "foreign"; reason: "customerId" | "email" };

/**
 * Decide a row's Person, mirroring `importPeopleAndMembers` exactly:
 * a shared-email row is forced ambiguous up front, otherwise ADR-0008
 * precedence (Customer ID → unambiguous email → insert) applies. On a match the
 * `set` is fill-only for name/phone, always adopts a Customer ID and refreshes
 * the original join date — and carries NO `email` at all (#756): a CSV may fill
 * this club's roster row, never re-key an existing human's identity. An INSERT
 * still carries it; see {@link MatchedPersonValues}.
 *
 * A match onto a Person only ANOTHER club holds is `foreign` instead (#759):
 * the row writes nothing. So is one onto a Person NO club holds, unless the
 * importing club is the one that last removed them (#855). See
 * {@link ExistingPersonRow.heldBy}.
 */
export function resolvePersonDecision(
	row: MappedMember,
	existing: ExistingPersonRow[],
	sharedEmails: Set<string>,
): PersonDecision {
	const emailNorm = norm(row.email);
	// A Customer-ID hit wins over the batch's shared-email override. The override
	// is about not FUSING two people on one address; a row naming an existing
	// member number is not a fusion, and forcing it to `ambiguous` skipped the
	// `foreign` post-check below and sent an insert carrying a Customer ID that
	// `people_customer_id_unique` already holds — a throw mid-file, with no
	// transaction to undo the rows before it (#759 review).
	const cid = norm(row.customerId);
	const cidHit = cid !== "" && existing.some((p) => norm(p.customerId) === cid);
	const match =
		!cidHit && emailNorm !== "" && sharedEmails.has(emailNorm)
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
		// A POST-check on the Person `resolvePerson` chose, never a pre-filter of
		// the list it chooses from (#759). It returns on the first Customer-ID
		// hit, so dropping foreign candidates beforehand lets a row carrying
		// ANOTHER club's member number fall through to the email arm — and from
		// there either to `insert`, minting the very Person this refuses, or to a
		// local email match, silently attaching the row to a DIFFERENT member of
		// this club. The Customer ID is the stronger identifier and a row claiming
		// a foreign one is the attack shape, so it is refused outright.
		//
		// An ALLOWLIST, not `=== "other_club_only"`: an orphan with no release
		// record in this club is refused too (#855), and a `heldBy` value added
		// later then fails closed instead of silently matching.
		if (!ATTACHABLE.has(current.heldBy)) {
			return { kind: "foreign", reason: match.kind };
		}
		// No `email` — a match does not re-key an existing Person's identity
		// (#756). The address still reaches the club's own roster row through
		// `classifyMembership` below.
		const set: MatchedPersonValues = {
			customerId: current.customerId ?? row.customerId,
			name: fillOnly(current.name, row.name) ?? current.name,
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

/** A Person carrying an address on a roster row, as the conflict check sees
 *  them: whether they are bound to an account decides whose sign-in a shared
 *  address can still break. */
export interface AddressHolder {
	id: string;
	linked: boolean;
}

/** Normalised address → the distinct Persons whose roster rows carry it. */
export type AddressHolders = ReadonlyMap<string, readonly AddressHolder[]>;

/**
 * Would writing `address` onto this row's roster entry leave SOMEONE unable to
 * sign in (#759)? Arm 3 of the bind rule refuses a Person when any OTHER
 * Person's roster row carries their address, so one shared address can lock
 * out both people. Reported, never refused, like the member edit form:
 * `members.email` is the club's own column.
 *
 * `holders` is `loadAddressHolders`' snapshot. Both sides of the import call
 * this one function, which keeps the preview and the commit agreeing.
 *
 * - `address` is what the import WRITES ({@link writtenAddress}), never the CSV
 *   cell: fill-only leaves an existing address in place, and reporting the
 *   cell would name an obstacle the import does not create.
 * - `subject` is the Person the row resolved to, or null for a row creating
 *   one (no Person yet, never linked). A row's own Person is never its own
 *   conflict, or every re-import would report the club's roster against itself.
 * - It is a conflict when an unlinked Person is on EITHER side: the subject,
 *   whose own bind the other holders now block, or any other holder, whose
 *   bind this write now blocks. Only when everyone involved is already bound
 *   to an account can nobody's sign-in change. An earlier cut returned early
 *   on a linked subject, as the edit form's `personEmailObstacle` does, and so
 *   hid the one lockout the report exists for: the OTHER holder, often in a
 *   club the importing admin cannot see (#854 review).
 */
export function addressConflictFor(
	holders: AddressHolders,
	address: string | null,
	subject: AddressHolder | null,
): boolean {
	const key = normalizeAddress(address);
	if (!key) return false;
	const others = (holders.get(key) ?? []).filter((h) => h.id !== subject?.id);
	if (others.length === 0) return false;
	return !subject?.linked || others.some((h) => !h.linked);
}

/**
 * {@link addressConflictFor} over the snapshot AND the addresses earlier rows
 * of this same file wrote, then records this row's write. Called by BOTH the
 * planner and the writer, in row order, so the two count identically.
 *
 * The snapshot alone missed a collision the file itself creates: two rows with
 * the same name and address but different Customer IDs are two Persons, and
 * `batchSharedEmails` only flags DIFFERENT names, so nothing reported that
 * neither could then sign in. A row already counted `ambiguous` skips the
 * in-file half: that collision is the ambiguous count, and reporting it twice
 * under two names would train admins to ignore both.
 */
export function checkWrittenAddress(
	snapshot: AddressHolders,
	writtenInFile: Map<string, AddressHolder[]>,
	address: string | null,
	subject: AddressHolder | null,
	personId: string,
	countedAmbiguous: boolean,
): boolean {
	const conflict =
		addressConflictFor(snapshot, address, subject) ||
		(!countedAmbiguous && addressConflictFor(writtenInFile, address, subject));
	const key = normalizeAddress(address);
	if (key) {
		const holders = writtenInFile.get(key) ?? [];
		if (!holders.some((h) => h.id === personId)) {
			holders.push({ id: personId, linked: subject?.linked ?? false });
		}
		writtenInFile.set(key, holders);
	}
	return conflict;
}

/**
 * The JS spelling of `normalizeEmail` (`account-link-logic.ts`), restated
 * because this module is pure and that one imports `#/db`. Keep the two in
 * step; `members-import-plan.test.ts` pins them against each other.
 */
export function normalizeAddress(
	value: string | null | undefined,
): string | null {
	return value?.trim().toLowerCase() || null;
}

/**
 * The address a membership decision newly WRITES, or null: a fresh roster
 * row's address, or an empty one the fill-only update fills. An address the
 * update merely preserves is not new, and is not checked.
 */
export function writtenAddress(md: MembershipDecision): string | null {
	if (md.kind === "insert") return md.values.email;
	return md.fills.find((f) => f.field === "email")?.to ?? null;
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
	/** Rows skipped (blank name). Does NOT include `foreignSkipped`. */
	toSkip: number;
	/** Rows refused because they matched a Person only another club holds
	 *  (#759), or one no club holds that this club did not last remove (#855).
	 *  Its own count, never folded into `toSkip`. */
	foreignSkipped: number;
	/** Rows imported whose written address another Person's roster row already
	 *  carries, in any club — neither can then sign in (#759). */
	addressConflicts: number;
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

/**
 * Why a `foreign` row was skipped, as its preview note (#759). Names no club
 * and no person: the importing admin has no business learning either.
 *
 * One wording for both refusals, deliberately (#855). "On another club's
 * roster" is false of an orphan no club holds, and a separate note for the
 * orphan would tell the importing admin whether a member number they typed
 * belongs to someone another club still holds. "Not on this club's roster" is
 * true of both and says nothing more.
 */
const NOT_ON_THIS_ROSTER =
	"belongs to someone who is not on this club's roster, so they can't be added from a file";

export const FOREIGN_SKIP_NOTE: Record<"customerId" | "email", string> = {
	customerId: `Skipped — this member number ${NOT_ON_THIS_ROSTER}`,
	email: `Skipped — this email ${NOT_ON_THIS_ROSTER}`,
};

/** The preview's one-line summary of every `foreign` row, from the same
 *  phrase as {@link FOREIGN_SKIP_NOTE} so the two cannot drift apart. */
export function foreignSkipSummary(count: number): string {
	return `${count} row(s) skipped: their member number or email ${NOT_ON_THIS_ROSTER}.`;
}

/** Added to a row's note when the address it writes is shared (#759). */
export const ADDRESS_CONFLICT_NOTE =
	"Another member already has this email on their roster entry, so neither can sign in until each has their own";

function withConflict(note: string | null, conflict: boolean): string | null {
	if (!conflict) return note;
	return note ? `${note} · ${ADDRESS_CONFLICT_NOTE}` : ADDRESS_CONFLICT_NOTE;
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
	addressHolders: AddressHolders,
	onResolved?: (rowIndex: number, person: ExistingPersonRow) => void,
): ImportPlan {
	const people = existingPeople.map((p) => ({ ...p }));
	const membershipByPerson = new Map<string, ExistingMembershipRow>();
	for (const m of existingMemberships) membershipByPerson.set(m.personId, m);
	const sharedEmails = batchSharedEmails(rows);
	const writtenInFile = new Map<string, AddressHolder[]>();

	const summary: PlanSummary = {
		toInsert: 0,
		toUpdate: 0,
		toSkip: 0,
		foreignSkipped: 0,
		addressConflicts: 0,
		peopleCreated: 0,
		peopleMatched: 0,
		ambiguous: 0,
		unparseablePositions: 0,
	};
	const previewRows: PreviewRow[] = [];
	let synthCounter = 0;

	for (const [rowIndex, row] of rows.entries()) {
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
		if (pd.kind === "foreign") {
			summary.foreignSkipped++;
			previewRows.push({
				name: row.name,
				email: row.email,
				phone: row.phone,
				joinedAt: isoOrNull(row.joinedAt),
				action: "skip",
				note: FOREIGN_SKIP_NOTE[pd.reason],
			});
			continue;
		}
		let personId: string;
		// The Person the address check is about, or null for a row creating one.
		let subject: AddressHolder | null = null;
		if (pd.kind === "customerId" || pd.kind === "email") {
			const current = people.find((p) => p.id === pd.id);
			if (!current) continue; // unreachable
			personId = current.id;
			subject = { id: current.id, linked: current.linked };
			summary.peopleMatched++;
			// `current.email` is deliberately NOT updated — the commit does not write
			// it on a match either, and mirroring a write that does not happen is
			// what made the preview promise a diff the commit would not perform.
			current.customerId = pd.set.customerId;
			current.name = pd.set.name;
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
				heldBy: "this_club",
				linked: false,
			});
		}

		const resolvedPerson = people.find((p) => p.id === personId);
		if (resolvedPerson) onResolved?.(rowIndex, resolvedPerson);
		const existingMember = membershipByPerson.get(personId);
		const md = classifyMembership(row, existingMember);
		const conflict = checkWrittenAddress(
			addressHolders,
			writtenInFile,
			writtenAddress(md),
			subject,
			personId,
			pd.kind === "ambiguous",
		);
		if (conflict) summary.addressConflicts++;
		if (md.kind === "update" && existingMember) {
			summary.toUpdate++;
			previewRows.push({
				name: row.name,
				email: row.email,
				phone: row.phone,
				joinedAt: isoOrNull(row.joinedAt),
				action: "update",
				note: withConflict(updateNote(md.fills, row.joinedAt), conflict),
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
				note: withConflict(
					pd.kind === "ambiguous"
						? "New — shares an email with another member; added separately"
						: null,
					conflict,
				),
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

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
import { and, eq, sql } from "drizzle-orm";
import { db } from "#/db";
import { activityLog, members, officerTerms } from "#/db/schema";
import { isPaid, mapRow, parseCsv } from "#/lib/members-csv";
import {
	type ExistingMembershipRow,
	type ExistingPersonRow,
	type ImportPlan,
	planImport,
} from "#/lib/members-import-plan";
import { toStoredPhone } from "#/lib/phone";
import { logActivity } from "./activity";
import { loadClubDefaultCountryCode } from "./clubs-logic";
import { assertStillClubAdmin, getMembership } from "./guards";
import {
	AccessRefreshRequired,
	isAccessContention,
	readAccessState,
	relevantAccess,
	sameAccess,
	trackRosterWrites,
} from "./import-access-state";
import {
	type ImportStats,
	importPeopleAndMembers,
	loadAddressHolders,
	loadPersonCandidates,
} from "./import-members-logic";
import {
	importHash,
	type OfficerAccessChange,
	planOfficerAccess,
	readOfficerApproval,
	signOfficerApproval,
} from "./import-officer-approval";

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
	officerAccessChanges: OfficerAccessChange[];
	officerAccessUnavailable?: string;
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
	userId?: string,
): Promise<ImportPreviewResult> {
	const parsed = parseAndValidate(csv);
	const paid = parsed.filter(isPaid);
	// Normalize phones to E.164 so the preview diff matches what the committing
	// writer (importPeopleAndMembers) will actually store (#295).
	const cc = await loadClubDefaultCountryCode(clubId);
	const mapped = paid
		.map(mapRow)
		.map((r) => ({ ...r, phone: toStoredPhone(r.phone, cc) }));

	// People are global (club-less) — the resolver matches across every club. Load
	// them through the SAME function the committing writer uses, never a copy of
	// its query: the two sides run identical pure decisions over this list, so a
	// difference here is a preview that promises something the commit will not do.
	const existingPeople: ExistingPersonRow[] =
		await loadPersonCandidates(clubId);
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

	// Through the same loader the writer calls internally, for the same reason
	// as `loadPersonCandidates` above: the conflict count is a promise about
	// what the commit will report.
	const addressHolders = await loadAddressHolders(mapped.map((r) => r.email));
	const plan = planImport(
		existingPeople,
		existingMemberships,
		mapped,
		addressHolders,
	);
	const officerAccessChanges: OfficerAccessChange[] = [];
	let officerAccessUnavailable: string | undefined;
	if (userId) {
		await db.transaction(
			async (tx) => {
				await assertStillClubAdmin(tx, userId, clubId);
				const { proposals } = await planOfficerAccess(
					tx,
					clubId,
					mapped,
					userId,
				);
				for (const [rowIndex, proposal] of proposals) {
					const approval = signOfficerApproval({
						userId,
						clubId,
						csvHash: importHash(csv),
						rowIndex,
						state: proposal.state,
					});
					if (approval)
						officerAccessChanges.push({ ...proposal.change, approval });
					else
						officerAccessUnavailable =
							"Officer access approvals are unavailable. You can still import the roster without granting offices.";
				}
			},
			{ isolationLevel: "repeatable read" },
		);
	}

	return {
		officerAccessChanges,
		officerAccessUnavailable,
		totalRows: parsed.length,
		paidRows: paid.length,
		unpaidSkipped: parsed.length - paid.length,
		summary: plan.summary,
		rows: plan.rows,
	};
}

export interface ImportCommitResult {
	officerGrants: number;
	officerRefreshRequired: string[];
	stats: ImportStats;
	totalRows: number;
	paidRows: number;
	unpaidSkipped: number;
}

/** Commit the upload: re-parse server-side and run the shared writer. */
export async function commitMemberImport(
	clubId: string,
	csv: string,
	approval?: { userId: string; officerApprovals?: string[] },
): Promise<ImportCommitResult> {
	const parsed = parseAndValidate(csv);
	const paid = parsed.filter(isPaid);
	const mapped = paid.map(mapRow);
	let officerGrants = 0;
	const officerRefreshRequired: string[] = [];
	const csvHash = importHash(csv);
	const selected = [...new Set(approval?.officerApprovals ?? [])].flatMap(
		(token) => {
			const signed = readOfficerApproval(token);
			if (
				!signed ||
				signed.userId !== approval?.userId ||
				signed.clubId !== clubId ||
				signed.csvHash !== csvHash
			) {
				officerRefreshRequired.push(
					"Officer approval is invalid or expired; refresh preview and approve again.",
				);
				return [];
			}
			return [{ signed, token }];
		},
	);
	const cc = await loadClubDefaultCountryCode(clubId);

	const normalized = mapped.map((r) => ({
		...r,
		phone: toStoredPhone(r.phone, cc),
	}));
	const planned =
		selected.length && approval
			? await db.transaction(
					(tx) => planOfficerAccess(tx, clubId, normalized, approval.userId),
					{ isolationLevel: "repeatable read" },
				)
			: undefined;
	const tracking = planned
		? trackRosterWrites(db, planned.snapshot)
		: undefined;
	const resolved = new Map<
		number,
		{ membershipId: string; personId: string }
	>();
	// Roster import completes independently. No grant locks span CSV processing.
	const stats = await importPeopleAndMembers(clubId, mapped, {
		countryCode: cc,
		write: tracking?.write,
		onResolved: (i, membershipId, personId) => {
			resolved.set(i, { membershipId, personId });
		},
	});
	if (planned && tracking && approval) {
		for (const { signed, token } of selected) {
			const proposal = planned.proposals.get(signed.rowIndex);
			const actual = resolved.get(signed.rowIndex);
			const origin = proposal
				? planned.createdAt.get(proposal.personId)
				: undefined;
			const expectedId =
				origin === undefined
					? proposal?.personId
					: tracking.createdPeople.get(origin);
			try {
				if (
					!proposal ||
					proposal.state !== signed.state ||
					!actual ||
					actual.personId !== expectedId
				)
					throw new AccessRefreshRequired();
				const expected = relevantAccess(
					planned.snapshot,
					actual.personId,
					approval.userId,
				);
				if (
					[...expected.identities, ...expected.roster].some((r) =>
						tracking.dirty.has(r.id),
					)
				)
					throw new AccessRefreshRequired();
				const person = expected.identities.find(
					(p) => p.id === actual.personId,
				);
				if (!person) throw new AccessRefreshRequired();
				const granted = await db.transaction(async (tx) => {
					if (signed.expires <= Date.now()) throw new AccessRefreshRequired();
					const current = await readAccessState(tx, clubId, approval.userId, {
						personId: actual.personId,
						userId: person.userId,
					});
					if (!sameAccess(expected, current)) throw new AccessRefreshRequired();
					// Club/user/session rows remain locked through both the grant and its audit.
					try {
						await assertStillClubAdmin(tx, approval.userId, clubId);
					} catch {
						throw new AccessRefreshRequired();
					}
					const targetIds = new Set(
						current.identities
							.filter(
								(p) =>
									p.id === person.id ||
									(person.userId && p.userId === person.userId),
							)
							.map((p) => p.id),
					);
					const memberIds = new Set(
						current.roster
							.filter((m) => targetIds.has(m.personId))
							.map((m) => m.id),
					);
					if (
						current.terms.some(
							(t) => memberIds.has(t.membershipId) && t.termEnd === null,
						)
					)
						throw new AccessRefreshRequired();
					const approvalId = importHash(token);
					const [used] = await tx
						.select({ id: activityLog.id })
						.from(activityLog)
						.where(
							and(
								eq(activityLog.clubId, clubId),
								sql`${activityLog.detail}->>'approvalId' = ${approvalId}`,
							),
						)
						.limit(1);
					if (used) throw new AccessRefreshRequired();
					const [term] = await tx
						.insert(officerTerms)
						.values({
							membershipId: actual.membershipId,
							position: proposal.change.position,
							termStart: new Date(),
						})
						.returning({
							id: officerTerms.id,
							membershipId: officerTerms.membershipId,
							position: officerTerms.position,
							termEnd: officerTerms.termEnd,
							version: sql<string>`${officerTerms}.xmin::text`,
						});
					const actor = await getMembership(approval.userId, clubId, tx);
					await logActivity(tx, {
						clubId,
						actorMemberId: actor?.status === "active" ? actor.id : null,
						impersonatedBy: actor?.status === "active" ? null : approval.userId,
						action: "member_edit",
						targetType: "member",
						targetId: actual.membershipId,
						detail: {
							source: "csv_officer_approval",
							approvalId,
							approvedBy: approval.userId,
							officersAdded: [proposal.change.position],
							row: signed.rowIndex + 1,
							csvHash,
						},
					});
					// Expiry is time-based and cannot be protected by a row lock.
					try {
						await assertStillClubAdmin(tx, approval.userId, clubId);
					} catch {
						throw new AccessRefreshRequired();
					}
					return term;
				});
				planned.snapshot.terms.push(granted);
				planned.snapshot.terms.sort((a, b) => a.id.localeCompare(b.id));
				officerGrants++;
				stats.skippedOfficerAssignments--;
			} catch (error) {
				if (
					!(error instanceof AccessRefreshRequired) &&
					!isAccessContention(error)
				)
					throw error;
				officerRefreshRequired.push(
					`Row ${signed.rowIndex + 1}: officer access or authorization changed; refresh preview and approve again.`,
				);
			}
		}
	}

	return {
		stats,
		officerGrants,
		officerRefreshRequired,
		totalRows: parsed.length,
		paidRows: paid.length,
		unpaidSkipped: parsed.length - paid.length,
	};
}

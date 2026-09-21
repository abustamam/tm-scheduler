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
import { activityLog, members } from "#/db/schema";
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
	type ImportStats,
	importPeopleAndMembers,
	loadPersonCandidates,
} from "./import-members-logic";
import {
	importHash,
	lockOfficerImport,
	type OfficerAccessChange,
	planOfficerAccess,
	readOfficerApproval,
	signOfficerApproval,
} from "./import-officer-approval";
import {
	currentOfficersFor,
	openOfficerTermIfAbsent,
} from "./officer-terms-logic";

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

	const plan = planImport(existingPeople, existingMemberships, mapped);
	const officerAccessChanges: OfficerAccessChange[] = [];
	if (userId) {
		await db.transaction(
			async (tx) => {
				await assertStillClubAdmin(tx, userId, clubId);
				const proposals = await planOfficerAccess(tx, clubId, mapped, userId);
				for (const [rowIndex, proposal] of proposals) {
					officerAccessChanges.push({
						...proposal.change,
						approval: signOfficerApproval({
							userId,
							clubId,
							csvHash: importHash(csv),
							rowIndex,
							state: proposal.state,
						}),
					});
				}
			},
			{ isolationLevel: "repeatable read" },
		);
	}

	return {
		officerAccessChanges,
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
	const stats =
		selected.length && approval
			? await db
					.transaction(async (tx) => {
						await lockOfficerImport(tx);
						await assertStillClubAdmin(tx, approval.userId, clubId);
						const normalized = mapped.map((r) => ({
							...r,
							phone: toStoredPhone(r.phone, cc),
						}));
						const current = await planOfficerAccess(
							tx,
							clubId,
							normalized,
							approval.userId,
						);
						const valid = new Map<number, string>();
						for (const { signed, token } of selected) {
							const proposal = current.get(signed.rowIndex);
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
							if (used || !proposal || proposal.state !== signed.state) {
								officerRefreshRequired.push(
									`Row ${signed.rowIndex + 1}: refresh preview and approve officer access again.`,
								);
								continue;
							}
							valid.set(signed.rowIndex, approvalId);
						}
						const resolved = new Map<number, string>();
						const imported = await importPeopleAndMembers(clubId, mapped, {
							conn: tx,
							countryCode: cc,
							onResolved: (i, id) => {
								resolved.set(i, id);
							},
						});
						const actor = await getMembership(approval.userId, clubId, tx);
						for (const [rowIndex, approvalId] of valid) {
							const membershipId = resolved.get(rowIndex);
							const position = mapped[rowIndex].officerPosition;
							if (
								!membershipId ||
								!position ||
								(await currentOfficersFor(membershipId, tx)).length
							) {
								officerRefreshRequired.push(
									`Row ${rowIndex + 1}: officer access changed; refresh preview.`,
								);
								continue;
							}
							if (
								await openOfficerTermIfAbsent(
									tx,
									membershipId,
									position,
									new Date(),
								)
							) {
								await logActivity(tx, {
									clubId,
									actorMemberId: actor?.status === "active" ? actor.id : null,
									impersonatedBy:
										actor?.status === "active" ? null : approval.userId,
									action: "member_edit",
									targetType: "member",
									targetId: membershipId,
									detail: {
										source: "csv_officer_approval",
										approvalId,
										approvedBy: approval.userId,
										officersAdded: [position],
										row: rowIndex + 1,
										csvHash,
									},
								});
								officerGrants++;
								imported.skippedOfficerAssignments--;
							}
						}
						return imported;
					})
					.catch(async (error: unknown) => {
						const cause =
							error instanceof Error && "cause" in error ? error.cause : error;
						const code =
							cause && typeof cause === "object" && "code" in cause
								? cause.code
								: null;
						if (code !== "55P03" && code !== "40P01") throw error;
						officerGrants = 0;
						officerRefreshRequired.splice(
							0,
							officerRefreshRequired.length,
							"Officer access is being changed elsewhere; roster imported without grants. Refresh preview and approve again.",
						);
						return importPeopleAndMembers(clubId, mapped);
					})
			: await importPeopleAndMembers(clubId, mapped);

	return {
		stats,
		officerGrants,
		officerRefreshRequired,
		totalRows: parsed.length,
		paidRows: paid.length,
		unpaidSkipped: parsed.length - paid.length,
	};
}

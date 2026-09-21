import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { members, officerTerms, people } from "#/db/schema";
import type { MappedMember } from "#/lib/members-csv";
import { type ExistingPersonRow, planImport } from "#/lib/members-import-plan";
import type { OfficerPosition } from "#/lib/officers";
import {
	type ImportConnection,
	loadPersonCandidates,
} from "./import-members-logic";

const approvalSchema = z.object({
	userId: z.string(),
	clubId: z.string().uuid(),
	csvHash: z.string(),
	rowIndex: z.number().int().nonnegative(),
	state: z.string(),
	expires: z.number(),
});
type Approval = z.infer<typeof approvalSchema>;
export interface OfficerAccessChange {
	rowIndex: number;
	name: string;
	email: string | null;
	customerId: string | null;
	personId: string | null;
	position: OfficerPosition;
	approval: string;
}
export const importHash = (value: string) =>
	createHash("sha256").update(value).digest("hex");

function signature(payload: string): Buffer {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret)
		throw new Error(
			"BETTER_AUTH_SECRET is required to approve officer access.",
		);
	// Domain-separated from the existing unsubscribe/session signing uses.
	return createHmac("sha256", secret)
		.update(`csv-officer-approval:v1:${payload}`)
		.digest();
}
export function signOfficerApproval(
	approval: Omit<Approval, "expires">,
): string {
	const payload = Buffer.from(
		JSON.stringify({ ...approval, expires: Date.now() + 15 * 60 * 1000 }),
	).toString("base64url");
	return `${payload}.${signature(payload).toString("base64url")}`;
}
export function readOfficerApproval(token: string): Approval | null {
	const [payload, encoded, extra] = token.split(".");
	if (!payload || !encoded || extra !== undefined) return null;
	const expected = Buffer.from(signature(payload).toString("base64url"));
	const actual = Buffer.from(encoded);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
		return null;
	try {
		const parsed = approvalSchema.safeParse(
			JSON.parse(Buffer.from(payload, "base64url").toString()),
		);
		return parsed.success && parsed.data.expires > Date.now()
			? parsed.data
			: null;
	} catch {
		return null;
	}
}

/**
 * Actual table locks, not a cooperative advisory lock: member edits, guest
 * conversion, membership collapse and account linking do not share one lock.
 * Blocking their writes also covers absent memberships and duplicate-Person
 * phantoms. Used only while applying selected grants; ordinary imports do not
 * take these database-wide locks. NOWAIT avoids lock-order deadlocks with
 * writers that already hold a different table; commit falls back to roster-only.
 */
export async function lockOfficerImport(conn: ImportConnection): Promise<void> {
	await conn.execute(sql`SET LOCAL lock_timeout = '5s'`);
	await conn.execute(
		sql`LOCK TABLE people, members, officer_terms IN SHARE ROW EXCLUSIVE MODE NOWAIT`,
	);
}

/** Compute approval state from server reads, including every Person for a user.
 * xmin detects revoke/reinstate (ABA), even if final column values are identical.
 * Full term history also detects a grant followed by a revocation since preview.
 */
export async function planOfficerAccess(
	conn: ImportConnection,
	clubId: string,
	rows: MappedMember[],
	approvingUserId: string,
) {
	const candidates = await loadPersonCandidates(clubId, conn);
	const identities = await conn
		.select({
			id: people.id,
			userId: people.userId,
			name: people.name,
			email: people.email,
			customerId: people.customerId,
			version: sql<string>`${people}.xmin::text`,
		})
		.from(people)
		.orderBy(people.id);
	const roster = await conn
		.select({
			id: members.id,
			personId: members.personId,
			name: members.name,
			email: members.email,
			phone: members.phone,
			status: members.status,
			clubRole: members.clubRole,
			version: sql<string>`${members}.xmin::text`,
		})
		.from(members)
		.where(eq(members.clubId, clubId))
		.orderBy(members.id);
	const terms = await conn
		.select({
			id: officerTerms.id,
			membershipId: officerTerms.membershipId,
			position: officerTerms.position,
			termEnd: officerTerms.termEnd,
			version: sql<string>`${officerTerms}.xmin::text`,
		})
		.from(officerTerms)
		.innerJoin(members, eq(members.id, officerTerms.membershipId))
		.where(eq(members.clubId, clubId))
		.orderBy(officerTerms.id);
	const approvingPeople = identities.filter(
		(p) => p.userId === approvingUserId,
	);
	const approvingIds = new Set(approvingPeople.map((p) => p.id));
	const approvingMemberships = roster.filter((m) =>
		approvingIds.has(m.personId),
	);
	const approvingMemberIds = new Set(approvingMemberships.map((m) => m.id));
	const approvingTerms = terms.filter((t) =>
		approvingMemberIds.has(t.membershipId),
	);
	const approver = {
		people: approvingPeople,
		memberships: approvingMemberships,
		terms: approvingTerms,
	};
	const resolved = new Map<number, ExistingPersonRow>();
	planImport(candidates, roster, rows, (i, person) => resolved.set(i, person));
	const proposals = new Map<
		number,
		{ state: string; change: Omit<OfficerAccessChange, "approval"> }
	>();
	for (const [rowIndex, resolvedPerson] of resolved) {
		const personId = resolvedPerson.id;
		const row = rows[rowIndex];
		if (!row.officerPosition) continue;
		const person = identities.find((p) => p.id === personId);
		const related = identities.filter(
			(p) =>
				p.id === personId || (person?.userId && p.userId === person.userId),
		);
		const ids = new Set(related.map((p) => p.id));
		const memberships = roster.filter((m) => ids.has(m.personId));
		const membershipIds = new Set(memberships.map((m) => m.id));
		const history = terms.filter((t) => membershipIds.has(t.membershipId));
		// Preserve existing assignments, including those on duplicate memberships.
		if (history.some((t) => t.termEnd === null)) continue;
		const change = {
			rowIndex,
			name: resolvedPerson.name,
			email: resolvedPerson.email,
			customerId: resolvedPerson.customerId,
			personId: person?.id ?? null,
			position: row.officerPosition,
		};
		const state = importHash(
			JSON.stringify({
				personId,
				related,
				memberships,
				history,
				change,
				approver,
			}),
		);
		proposals.set(rowIndex, { state, change });
	}
	return proposals;
}

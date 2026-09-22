import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { MappedMember } from "#/lib/members-csv";
import { type ExistingPersonRow, planImport } from "#/lib/members-import-plan";
import type { OfficerPosition } from "#/lib/officers";
import { readAccessState, relevantAccess } from "./import-access-state";
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

function signature(payload: string): Buffer | null {
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) return null;
	// Domain-separated from the existing unsubscribe/session signing uses.
	return createHmac("sha256", secret)
		.update(`csv-officer-approval:v1:${payload}`)
		.digest();
}
export function signOfficerApproval(
	approval: Omit<Approval, "expires">,
): string | null {
	const payload = Buffer.from(
		JSON.stringify({ ...approval, expires: Date.now() + 15 * 60 * 1000 }),
	).toString("base64url");
	const signed = signature(payload);
	return signed ? `${payload}.${signed.toString("base64url")}` : null;
}
export function readOfficerApproval(token: string): Approval | null {
	const [payload, encoded, extra] = token.split(".");
	if (!payload || !encoded || extra !== undefined) return null;
	const signed = signature(payload);
	if (!signed) return null;
	const expected = Buffer.from(signed.toString("base64url"));
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

export async function planOfficerAccess(
	conn: ImportConnection,
	clubId: string,
	rows: MappedMember[],
	approvingUserId: string,
) {
	const candidates = await loadPersonCandidates(clubId, conn);
	const snapshot = await readAccessState(conn, clubId, approvingUserId);
	const { identities, roster, terms } = snapshot;
	const resolved = new Map<number, ExistingPersonRow>();
	const createdAt = new Map<string, number>();
	planImport(candidates, roster, rows, (i, person) => {
		resolved.set(i, { ...person });
		if (
			!identities.some((p) => p.id === person.id) &&
			!createdAt.has(person.id)
		)
			createdAt.set(person.id, i);
	});
	const proposals = new Map<
		number,
		{
			state: string;
			personId: string;
			change: Omit<OfficerAccessChange, "approval">;
		}
	>();
	for (const [rowIndex, resolvedPerson] of resolved) {
		const personId = resolvedPerson.id;
		const row = rows[rowIndex];
		if (!row.officerPosition) continue;
		const person = identities.find((p) => p.id === personId);
		const relatedIds = new Set(
			identities
				.filter(
					(p) =>
						p.id === personId || (person?.userId && p.userId === person.userId),
				)
				.map((p) => p.id),
		);
		const memberIds = new Set(
			roster.filter((m) => relatedIds.has(m.personId)).map((m) => m.id),
		);
		if (terms.some((t) => memberIds.has(t.membershipId) && t.termEnd === null))
			continue;
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
				change,
				access: relevantAccess(snapshot, personId, approvingUserId),
			}),
		);
		proposals.set(rowIndex, { state, change, personId });
	}
	return { snapshot, proposals, createdAt };
}

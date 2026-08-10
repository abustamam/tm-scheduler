/**
 * Who may win each award on a meeting (#510), with display names.
 *
 * ONE derivation, read by two callers that must never disagree: the public
 * ballot renders it, and `castVote` validates against it. If they drifted, the
 * ballot would offer a candidate the server rejects — a failure that only shows
 * up mid-meeting.
 *
 * Best Speaker  → holders of `speaker`-category role slots
 * Best Evaluator→ holders of `evaluator`-category role slots
 * Best Table Topics → the meeting's recorded Table Topics speakers
 *
 * Names ONLY. No email, no phone: the ballot is a fully public surface and the
 * public club sheet is a soft gate, so contact details must never reach it.
 * `award-candidates.integration.test.ts` asserts that directly.
 */
import { asc, eq } from "drizzle-orm";
import { db } from "#/db";
import {
	guests,
	members,
	roleDefinitions,
	roleSlots,
	tableTopicsSpeakers,
} from "#/db/schema";
import { AWARD_CATEGORIES, type AwardCategory } from "./minutes-logic";

/** A person who may win an award. `kind` discriminates the id's table. */
export interface AwardCandidate {
	kind: "member" | "guest";
	id: string;
	name: string;
}

export type AwardCandidates = Record<AwardCategory, AwardCandidate[]>;

export async function loadAwardCandidates(
	meetingId: string,
): Promise<AwardCandidates> {
	// `members.name` is the per-club authoritative display name, denormalized on
	// purpose (#486) — it is what `loadMinutes` already reads for award winners.
	// Do NOT join through `people.name`: the two diverge, and the ballot must
	// show the same name every other surface shows.
	const slotRows = await db
		.select({
			category: roleDefinitions.category,
			memberId: roleSlots.assignedMemberId,
			guestId: roleSlots.assignedGuestId,
			memberName: members.name,
			guestName: guests.name,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.leftJoin(members, eq(members.id, roleSlots.assignedMemberId))
		.leftJoin(guests, eq(guests.id, roleSlots.assignedGuestId))
		.where(eq(roleSlots.meetingId, meetingId))
		.orderBy(asc(roleDefinitions.sortOrder), asc(roleSlots.slotIndex));

	const ttRows = await db
		.select({
			memberId: tableTopicsSpeakers.memberId,
			guestId: tableTopicsSpeakers.guestId,
			memberName: members.name,
			guestName: guests.name,
		})
		.from(tableTopicsSpeakers)
		.leftJoin(members, eq(members.id, tableTopicsSpeakers.memberId))
		.leftJoin(guests, eq(guests.id, tableTopicsSpeakers.guestId))
		.where(eq(tableTopicsSpeakers.meetingId, meetingId))
		.orderBy(asc(tableTopicsSpeakers.sortOrder));

	const empty = (): AwardCandidates => ({
		best_speaker: [],
		best_evaluator: [],
		best_table_topics: [],
	});
	const out = empty();
	// De-dupe per category: a member may hold two speaker slots and must appear
	// on the ballot once. Keyed by `kind:id`, insertion-ordered.
	const seen: Record<AwardCategory, Set<string>> = {
		best_speaker: new Set(),
		best_evaluator: new Set(),
		best_table_topics: new Set(),
	};

	const push = (
		category: AwardCategory,
		row: {
			memberId: string | null;
			guestId: string | null;
			memberName: string | null;
			guestName: string | null;
		},
	) => {
		const kind = row.memberId ? "member" : row.guestId ? "guest" : null;
		if (!kind) return;
		const id = (row.memberId ?? row.guestId) as string;
		const name = (kind === "member" ? row.memberName : row.guestName) ?? "";
		if (!name) return;
		const key = `${kind}:${id}`;
		if (seen[category].has(key)) return;
		seen[category].add(key);
		out[category].push({ kind, id, name });
	};

	for (const r of slotRows) {
		if (r.category === "speaker") push("best_speaker", r);
		else if (r.category === "evaluator") push("best_evaluator", r);
	}
	for (const r of ttRows) push("best_table_topics", r);

	return out;
}

/** True when `candidate` is eligible for `category` on this meeting. */
export function isEligibleCandidate(
	candidates: AwardCandidates,
	category: AwardCategory,
	candidate: { kind: "member" | "guest"; id: string },
): boolean {
	return candidates[category].some(
		(c) => c.kind === candidate.kind && c.id === candidate.id,
	);
}

export { AWARD_CATEGORIES };

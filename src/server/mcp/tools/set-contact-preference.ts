/**
 * `set_contact_preference` — an officer sets how one or more members want to be
 * reached (#1543). The agent-side twin of the roster edit's "Preferred contact"
 * field (#1093), and it writes through THE SAME WRITER: `applyMemberEdit`, whose
 * preference UPDATE carries the rules in its own WHERE (the method needs its
 * contact detail, the member has not chosen it themselves, #1110, and this club
 * is the Person's sole holder). There is no second copy of those rules here.
 *
 * The preview needs each member's verdict WITHOUT writing, which the writer
 * cannot give, so the preview READS the same facts through the helpers the
 * roster page already uses for its read-only explanation
 * (`contactPreferenceRefusalFor`, `availableContactMethods`). A preview is a
 * prediction, never the gate: the apply re-plans, compares the `planHash`
 * (`PLAN_STALE` on a drift), then lets `applyMemberEdit`'s UPDATE decide, and a
 * member it refuses at that point is reported as refused, not as changed.
 *
 * Decision (triage on #1543): a refused member does not block the others. The
 * apply changes the members the plan marked "would change" and reports the rest.
 *
 * One rule is the tool's own: a Person who has signed in owns their own data, so
 * the preference is theirs to set (the roster form already hides the field for
 * them). `applyMemberEdit` does not enforce that, so the plan refuses it and the
 * apply's re-plan re-checks it; the window between that re-check and the UPDATE
 * is a few statements wide.
 *
 * Recorded as the club's change (`contact_preference_by = 'officer'`) with the
 * officer credited in the feed, exactly as the roster edit records an admin.
 * GavelUp messages no one.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { planHash } from "#/lib/mcp-plan";
import {
	availableContactMethods,
	CONTACT_METHOD_UNAVAILABLE_MESSAGE,
	CONTACT_METHODS,
	CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE,
	CONTACT_PREFERENCE_MULTI_CLUB_MESSAGE,
	type ContactMethod,
} from "#/lib/preferred-contact";
import { loadClubContactPreferences } from "#/server/contact-preference-logic";
import {
	applyMemberEdit,
	contactPreferenceRefusalFor,
} from "#/server/members-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const TOOL = "set_contact_preference";
const MAX_MEMBERS = 100;

const inputSchema = {
	clubId: z.string().uuid(),
	memberIds: z
		.array(z.string().uuid())
		.min(1)
		.max(MAX_MEMBERS)
		.describe("Members to set, from find_people."),
	method: z
		.enum([...CONTACT_METHODS, "none"])
		.describe("How to reach them, or none to clear the preference."),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

export const NOT_ON_ROSTER_MESSAGE =
	"That member is not on this club's roster. find_people lists who is.";
export const SIGNS_IN_MESSAGE =
	"This member signs in themself, so their contact preference is theirs to set.";
export const NO_PHONE_MESSAGE =
	"This member has no phone number on file. Add one first.";
export const NO_EMAIL_MESSAGE =
	"This member has no email address on file. Add one first.";
export const PLAN_STALE_MESSAGE =
	"The members changed since you previewed this. Review the fresh plan and ask the user again.";
const CHANGED_SINCE_MESSAGE =
	"This member changed while the request ran, so nothing was written for them.";

type Verdict = "would_change" | "already_set" | "refused";
type RefusalCode =
	| "not_on_roster"
	| "signs_in"
	| "member_set"
	| "multi_club"
	| "no_phone"
	| "no_email"
	| "changed_since_preview";

interface PlanRow {
	memberId: string;
	name: string | null;
	verdict: Verdict;
	/** The preference shown today (never the raw column), or null. */
	current: ContactMethod | null;
	refusal: { code: RefusalCode; message: string } | null;
}

/** What the apply needs beyond the (hashed) plan rows. */
interface Subject {
	memberId: string;
	name: string;
	preferredName: string | null;
}

const refusalMessages: Record<RefusalCode, string> = {
	not_on_roster: NOT_ON_ROSTER_MESSAGE,
	signs_in: SIGNS_IN_MESSAGE,
	member_set: CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE,
	multi_club: CONTACT_PREFERENCE_MULTI_CLUB_MESSAGE,
	no_phone: NO_PHONE_MESSAGE,
	no_email: NO_EMAIL_MESSAGE,
	changed_since_preview: CHANGED_SINCE_MESSAGE,
};
const refuse = (code: RefusalCode) => ({
	code,
	message: refusalMessages[code],
});

async function compute(
	clubId: string,
	ids: string[],
	method: ContactMethod | null,
): Promise<{ rows: PlanRow[]; subjects: Map<string, Subject> }> {
	const found = await db
		.select({
			id: members.id,
			name: members.name,
			preferredName: members.preferredName,
			personId: members.personId,
			email: people.email,
			phone: people.phone,
			userId: people.userId,
		})
		.from(members)
		.innerJoin(people, eq(people.id, members.personId))
		.where(and(eq(members.clubId, clubId), inArray(members.id, ids)));
	// The shown preference, resolved by the shared reader: this file never names
	// the raw column (preferred-contact-reads.guard.test.ts).
	const shown = await loadClubContactPreferences(clubId);
	const byId = new Map(found.map((r) => [r.id, r]));
	const subjects = new Map<string, Subject>();
	const rows: PlanRow[] = [];
	for (const id of ids) {
		const m = byId.get(id);
		if (!m) {
			rows.push({
				memberId: id,
				name: null,
				verdict: "refused",
				current: null,
				refusal: refuse("not_on_roster"),
			});
			continue;
		}
		subjects.set(id, {
			memberId: id,
			name: m.name,
			preferredName: m.preferredName,
		});
		const base = {
			memberId: id,
			name: m.name,
			current: shown.get(id) ?? null,
		};
		const refused = (code: RefusalCode): PlanRow => ({
			...base,
			verdict: "refused",
			refusal: refuse(code),
		});
		if (m.userId !== null) {
			rows.push(refused("signs_in"));
			continue;
		}
		// The roster page's own read of the writer's two ownership rules.
		const owner = await contactPreferenceRefusalFor(m.personId, clubId);
		if (owner) {
			rows.push(refused(owner));
			continue;
		}
		if ((shown.get(id) ?? null) === method) {
			rows.push({ ...base, verdict: "already_set", refusal: null });
			continue;
		}
		if (method !== null && !availableContactMethods(m).includes(method)) {
			rows.push(refused(method === "email" ? "no_email" : "no_phone"));
			continue;
		}
		rows.push({ ...base, verdict: "would_change", refusal: null });
	}
	return { rows, subjects };
}

const summarize = (rows: PlanRow[]) => ({
	wouldChange: rows.filter((r) => r.verdict === "would_change").length,
	alreadySet: rows.filter((r) => r.verdict === "already_set").length,
	refused: rows.filter((r) => r.verdict === "refused").length,
});

export const setContactPreferenceTool: McpToolDefinition = {
	name: TOOL,
	audience: "officer",
	// "none" clears a preference; repeating the same call changes nothing more.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
	},
	config: {
		title: "Set members' preferred contact method",
		description:
			"Set how one or more members want to be reached (email, call, sms, " +
			"whatsapp, or none to clear), as a club admin would on the roster. Ids " +
			"come from find_people. Call once WITHOUT planHash to preview: it " +
			"writes nothing and lists, per member, would_change, already_set or " +
			"refused with the reason (no phone, no email, the member chose their " +
			"own, on another club's roster, signs in themself), plus a planHash. " +
			"Show the plan to the user in full; after they agree, call again with " +
			"the same input plus the planHash. A refused member does not block the " +
			"others: the apply changes the would_change members and reports the " +
			"rest. GavelUp messages no one.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx, args.clubId);
		const method: ContactMethod | null =
			args.method === "none" ? null : args.method;
		// A uuid is case-insensitive to the schema, not to the Map keys below.
		const ids = [...new Set(args.memberIds.map((i) => i.toLowerCase()))];

		const hashOf = (rows: PlanRow[]) =>
			planHash({
				tool: TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan: { method, rows },
			});
		const view = (rows: PlanRow[]) => ({
			clubId: club.clubId,
			method: args.method,
			summary: summarize(rows),
			members: rows,
		});

		const { rows, subjects } = await compute(club.clubId, ids, method);
		if (!args.planHash) {
			return { applied: false, plan: view(rows), planHash: hashOf(rows) };
		}
		if (hashOf(rows) !== args.planHash) {
			throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
				plan: view(rows),
				planHash: hashOf(rows),
			});
		}

		// The shared writer, one member at a time (it is its own transaction and
		// retries its own deadlocks). Its UPDATE is the gate: a member it refuses
		// is reported, and the others still land.
		const results: PlanRow[] = [];
		for (const row of rows) {
			const subject = subjects.get(row.memberId);
			if (row.verdict !== "would_change" || !subject) {
				results.push(row);
				continue;
			}
			try {
				await applyMemberEdit({
					clubId: club.clubId,
					memberId: subject.memberId,
					// The edit's name and goes-by are not ours to change: send what the
					// roster holds (an omitted goes-by would clear it).
					name: subject.name,
					preferredName: subject.preferredName,
					preferredContact: method,
					actorMemberId: club.membershipId,
				});
				results.push({ ...row, current: method });
			} catch (err) {
				const message = err instanceof Error ? err.message : "";
				const code: RefusalCode =
					message === CONTACT_PREFERENCE_MEMBER_OWNED_MESSAGE
						? "member_set"
						: message === CONTACT_PREFERENCE_MULTI_CLUB_MESSAGE
							? "multi_club"
							: message === CONTACT_METHOD_UNAVAILABLE_MESSAGE
								? method === "email"
									? "no_email"
									: "no_phone"
								: "changed_since_preview";
				results.push({ ...row, verdict: "refused", refusal: refuse(code) });
			}
		}
		return {
			applied: true,
			clubId: club.clubId,
			method: args.method,
			changed: results.filter((r) => r.verdict === "would_change"),
			alreadySet: results.filter((r) => r.verdict === "already_set"),
			refused: results.filter((r) => r.verdict === "refused"),
			note: "GavelUp tells no one. Let the members know yourself if they should hear of this.",
		};
	},
};

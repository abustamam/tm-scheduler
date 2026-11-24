/**
 * `merge_members` — an admin folds one duplicate member record into another
 * (#1665). The connector's twin of the roster's merge (`mergeMembers`), writing
 * through THE SAME WRITER (`applyMemberMerge`, members-logic.ts). This file never
 * reimplements the merge.
 *
 * The preview is the app's own writer run in a transaction that always rolls
 * back (`previewMemberMerge`), so the counts it shows are the apply's. Beside
 * them it names both members the way `find_people` does, contact masked.
 *
 * Blocking items are `{ code, message }`: a refusal the app gives (the same
 * member twice, an absorbed member who can sign in) is one `MERGE_REFUSED` item
 * carrying the app's own sentence; apply then returns `BLOCKED`. A member outside
 * the token's club is `NOT_FOUND`.
 *
 * Authorization: `audience: "officer"` through `authorizeToken` is exactly the
 * set `requireClubRole(["admin"])` admits in the app, which `mergeMembers` uses:
 * a club admin or an open-term officer (`isEffectiveAdmin`, #202). No further
 * gate. The writer takes no freshness hook, so a change committed between the
 * hash comparison and the merge is not caught here.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members, people } from "#/db/schema";
import { planHash } from "#/lib/mcp-plan";
import {
	applyMemberMerge,
	MEMBER_MERGE_NOT_FOUND_MESSAGE,
	MEMBER_MERGE_REFUSALS,
	type MemberKeepAfter,
	previewMemberMerge,
} from "#/server/members-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import { maskEmail, maskPhone, toMcpMember } from "../serialize";
import type { McpToolDefinition } from "../tool";

const TOOL = "merge_members";

const inputSchema = {
	clubId: z.string().uuid(),
	keepMemberId: z
		.string()
		.uuid()
		.describe("The member record that stays, from find_people."),
	absorbMemberId: z
		.string()
		.uuid()
		.describe(
			"The duplicate member record folded into the kept one and then deleted, from find_people.",
		),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

export const MEMBER_NOT_FOUND_MESSAGE =
	"One of those members is not in this club. find_people lists the club's members.";
export const PLAN_STALE_MESSAGE =
	"One of the members changed since you previewed this. Review the fresh plan and ask the user again.";
export const IRREVERSIBLE_NOTE =
	"This cannot be undone: the absorbed member record is deleted.";

interface MemberView {
	id: string;
	kind: "member";
	name: string;
	preferredName: string | null;
	status: string;
	clubRole: string;
	emailMasked: string | null;
	phoneMasked: string | null;
}

interface Plan {
	keep: MemberView;
	/** The kept member as the merge leaves it (status, role, end date, mentor listing). */
	keepAfter: MemberKeepAfter | null;
	absorb: MemberView;
	moved: Record<string, number>;
	notCarriedOver: Record<string, number>;
	note: string;
	blocking: { code: string; message: string }[];
}

interface Row {
	id: string;
	name: string;
	preferredName: string | null;
	status: string;
	clubRole: string;
	email: string | null;
	phone: string | null;
}

function viewOf(r: Row): MemberView {
	const m = toMcpMember(r);
	return {
		id: m.id,
		kind: "member",
		name: m.name,
		preferredName: m.preferredName,
		status: r.status,
		clubRole: r.clubRole,
		emailMasked: maskEmail(r.email),
		phoneMasked: maskPhone(r.phone),
	};
}

/** The raw contact the plan only shows masked; hashed, never returned. */
const rawContactOf = (r: Row) => ({ email: r.email, phone: r.phone });

const nonZero = (c: Record<string, number>) =>
	Object.fromEntries(Object.entries(c).filter(([, n]) => n > 0));

export const mergeMembersTool: McpToolDefinition = {
	name: TOOL,
	audience: "officer",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Merge two duplicate member records",
		description:
			"Fold one duplicate member record into another of the same club, as a " +
			"club admin would on the roster: the absorbed member's role slots, " +
			"attendance, awards, dues, officer terms and other records move to the " +
			"kept member and the absorbed record is deleted. IRREVERSIBLE. Club " +
			"admins only. Ids from find_people. Refused for the same member twice " +
			"and for an absorbed member who can sign in (keep that one instead). " +
			"Call once WITHOUT planHash to preview: it writes nothing, shows both " +
			"members (masked contact), the rows that move per table, and any " +
			"refusal, and returns a planHash. keepAfter is the kept member's " +
			"status, role, end date and mentor listing once merged (a merge can " +
			"end the kept member, close officer terms and release upcoming roles). " +
			"notCarriedOver counts rows naming the absorbed member that the kept " +
			"member does not get: duplicates, released upcoming roles, and rows " +
			"removed with the absorbed record. Show the plan to the user in full; " +
			"after they agree, call again with the same input plus the planHash. " +
			"GavelUp messages no one.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx, args.clubId);
		const keeperId = args.keepMemberId.toLowerCase();
		const absorbedId = args.absorbMemberId.toLowerCase();
		const merge = {
			clubId: club.clubId,
			keeperId,
			absorbedId,
			actorMemberId: club.membershipId,
		};

		interface Built {
			plan: Plan;
			raw: ReturnType<typeof rawContactOf>[];
		}
		const hashOf = (b: Built) =>
			planHash({
				tool: TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan: { shown: b.plan, rawContact: b.raw },
			});
		const withClub = (p: Plan) => ({ clubId: club.clubId, ...p });

		const buildPlan = async (): Promise<Built> => {
			const rows: Row[] = await db
				.select({
					id: members.id,
					name: members.name,
					preferredName: members.preferredName,
					status: members.status,
					clubRole: members.clubRole,
					email: people.email,
					phone: people.phone,
				})
				.from(members)
				.innerJoin(people, eq(people.id, members.personId))
				.where(
					and(
						inArray(members.id, [keeperId, absorbedId]),
						eq(members.clubId, club.clubId),
					),
				);
			const keep = rows.find((r) => r.id === keeperId);
			const absorb = rows.find((r) => r.id === absorbedId);
			if (!keep || !absorb) {
				throw new McpError("NOT_FOUND", MEMBER_NOT_FOUND_MESSAGE);
			}
			const dry = await previewMemberMerge(merge);
			return {
				plan: {
					keep: viewOf(keep),
					keepAfter: dry.keepAfter,
					absorb: viewOf(absorb),
					moved: nonZero(dry.moved),
					notCarriedOver: nonZero(dry.notCarriedOver),
					note: IRREVERSIBLE_NOTE,
					blocking: dry.refusal
						? [{ code: "MERGE_REFUSED", message: dry.refusal }]
						: [],
				},
				raw: [rawContactOf(keep), rawContactOf(absorb)],
			};
		};

		const built = await buildPlan();
		const p = built.plan;
		if (!args.planHash) {
			return { applied: false, plan: withClub(p), planHash: hashOf(built) };
		}
		if (hashOf(built) !== args.planHash) {
			throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
				plan: withClub(p),
				planHash: hashOf(built),
			});
		}
		if (p.blocking.length > 0) {
			throw new McpError(
				"BLOCKED",
				`Nothing was changed — ${p.blocking.length} problem${p.blocking.length === 1 ? "" : "s"} to fix first.`,
				{ blocking: p.blocking },
			);
		}

		try {
			await applyMemberMerge(merge);
		} catch (e) {
			if (e instanceof Error) {
				if (MEMBER_MERGE_REFUSALS.has(e.message)) {
					throw new McpError("BLOCKED", e.message, {
						blocking: [{ code: "MERGE_REFUSED", message: e.message }],
					});
				}
				if (e.message === MEMBER_MERGE_NOT_FOUND_MESSAGE) {
					throw new McpError("NOT_FOUND", MEMBER_NOT_FOUND_MESSAGE);
				}
			}
			throw e;
		}
		return {
			applied: true,
			clubId: club.clubId,
			keptMemberId: keeperId,
			absorbedMemberId: absorbedId,
			plan: withClub(p),
		};
	},
};

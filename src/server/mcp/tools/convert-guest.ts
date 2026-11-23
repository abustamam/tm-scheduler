/**
 * `convert_guest` — an officer turns a guest into a club member, or links the
 * guest to a member who already exists (#1664). The connector's twin of the
 * guest board's "Convert to member" and "Already a member?" actions, writing
 * through THE SAME WRITERS (`applyConvertGuestToMember`, `applyLinkGuestToMember`
 * in `guest-pipeline-logic.ts`). This file never reimplements either.
 *
 * Input: a `guestId`, plus a `memberId` to LINK to that member; omit `memberId`
 * to create a NEW member from the guest. The plan says which one applies.
 *
 * The app has no preview for either write, so the plan is built from read-only
 * queries (the guest's stage, pointer, visit count and slots held, the member's
 * status) and a refusal the app would give that those queries can see is a
 * `blocking` item. A refusal only the write can see (a roster name clash, a
 * race) is raised at apply: a thrown KNOWN refusal sentence maps to `BLOCKED`
 * carrying that sentence, a changed record to `PLAN_STALE`, anything else
 * propagates as INTERNAL.
 *
 * Staleness: the plan hash covers the guest and member rows as the plan shows
 * them, so a stage change, a new visit or a slot assigned changes it. Apply
 * re-plans and compares hashes BEFORE calling the app. Neither writer takes a
 * freshness hook, so a change committed between that comparison and the
 * writer's own locks is not caught here; each writer re-reads under its locks
 * and refuses the unsafe cases (reported as `PLAN_STALE` or `BLOCKED`).
 *
 * Convert from here never confirms an address: an address a visitor typed on
 * the public guest book is left off, and the officer confirms it in the app.
 *
 * Authorization: `audience: "officer"` through `authorizeToken`, and both ids
 * are looked up inside the token's club.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { members } from "#/db/schema";
import {
	CONVERT_NAME_CLASH_MESSAGE,
	LINK_ALREADY_JOINED_MESSAGE,
	LINK_MEMBER_NOT_IN_CLUB_MESSAGE,
} from "#/lib/guest-convert";
import { planHash } from "#/lib/mcp-plan";
import {
	applyConvertGuestToMember,
	applyLinkGuestToMember,
	LINK_MEMBER_FORMER_MESSAGE,
	loadGuestPipeline,
	type PipelineGuestRow,
} from "#/server/guest-pipeline-logic";
import {
	GUEST_NOT_IN_CLUB_MESSAGE,
	RECORD_CHANGED_MESSAGE,
} from "#/server/guests-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import { toMcpGuest } from "../serialize";
import type { McpToolDefinition } from "../tool";

const TOOL = "convert_guest";

const inputSchema = {
	clubId: z.string().uuid(),
	guestId: z.string().uuid().describe("The guest, from find_people."),
	memberId: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Omit to create a NEW member from this guest. Pass an existing member's id (from find_people) to link the guest to that member instead.",
		),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

export const GUEST_NOT_FOUND_MESSAGE =
	"That guest is not in this club. find_people lists the club's guests.";
export const MEMBER_NOT_FOUND_MESSAGE =
	"That member is not on this club's roster. find_people lists who is.";
export const PLAN_STALE_MESSAGE =
	"The guest or member changed since you previewed this. Review the fresh plan and ask the user again.";
/** Thrown by `applyConvertGuestToMember` as a literal; not exported there. */
const ALREADY_CONVERTED_MESSAGE =
	"This guest has already been converted to a member.";

const KNOWN_REFUSALS = new Set<string>([
	LINK_ALREADY_JOINED_MESSAGE,
	LINK_MEMBER_FORMER_MESSAGE,
	LINK_MEMBER_NOT_IN_CLUB_MESSAGE,
	CONVERT_NAME_CLASH_MESSAGE,
	ALREADY_CONVERTED_MESSAGE,
]);

interface Plan {
	/** `create_member`: a new member is made from the guest. `link_to_member`: the guest is pointed at an existing member. */
	mode: "create_member" | "link_to_member";
	guest: {
		id: string;
		name: string;
		preferredName: string | null;
		emailMasked: string | null;
		phoneMasked: string | null;
		stage: string;
		visitCount: number;
		/** Role slots the guest holds now; every one moves to the member. */
		heldSlotCount: number;
	};
	member: { id: string; name: string; status: string } | null;
	carriesOver: string[];
	doesNotCarryOver: string[];
	blocking: { code: string; message: string }[];
}

function planOf(
	g: PipelineGuestRow,
	member: { id: string; name: string; status: string } | null,
	linking: boolean,
): Plan {
	const m = toMcpGuest(g);
	const blocking: Plan["blocking"] = [];
	if (linking) {
		// A stranded guest (joined, no pointer) may be linked: that is the recovery.
		if (g.stage === "joined" && g.convertedMembershipId) {
			blocking.push({
				code: "GUEST_ALREADY_CONVERTED",
				message: LINK_ALREADY_JOINED_MESSAGE,
			});
		}
		if (member?.status === "former") {
			blocking.push({
				code: "MEMBER_FORMER",
				message: LINK_MEMBER_FORMER_MESSAGE,
			});
		}
	} else if (g.stage === "joined") {
		blocking.push({
			code: "GUEST_ALREADY_CONVERTED",
			message: ALREADY_CONVERTED_MESSAGE,
		});
	}
	const slots =
		"Every role slot the guest holds (" +
		g.heldSlotCount +
		") moves to the member, past and upcoming. The guest's earlier visits stay as guest history.";
	return {
		mode: linking ? "link_to_member" : "create_member",
		guest: {
			id: g.id,
			name: m.name,
			preferredName: m.preferredName,
			emailMasked: m.emailMasked,
			phoneMasked: m.phoneMasked,
			stage: g.stage,
			visitCount: g.visitCount,
			heldSlotCount: g.heldSlotCount,
		},
		member,
		carriesOver: linking
			? [
					slots,
					"The guest is marked joined and pointed at that member; the link can be reversed in the app.",
				]
			: [
					slots,
					"A new roster member is created with the guest's name and on-file contact, or an existing membership of the same person is reused (a lapsed one is woken, its admin role set back to member).",
					"The guest is marked joined and pointed at the new member.",
				],
		doesNotCarryOver: linking
			? []
			: [
					"An address the visitor typed on the public guest book is left off; confirm it in the app.",
				],
		blocking,
	};
}

export const convertGuestTool: McpToolDefinition = {
	name: TOOL,
	audience: "officer",
	// It re-points the guest's slots and rewrites who a person is on the roster,
	// and a second call does not undo the first.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Convert a guest to a member",
		description:
			"Turn one guest into a club member, as a club admin would on the guest " +
			"board. Id from find_people. Without memberId it creates a NEW member " +
			"from the guest. With memberId it links the guest to that EXISTING " +
			"member instead (for someone who joined without going through the " +
			"guest card). Either way the guest's role slots move to the member and " +
			"the guest is marked joined. Refused for a guest already converted, a " +
			"former member as the link target, and (new member only) a name already " +
			"on the roster, where the answer is to link. Call once WITHOUT planHash " +
			"to preview: it writes nothing, says which of the two applies, what " +
			"carries over and any refusal, and returns a planHash. Show the plan to " +
			"the user in full; after they agree, call again with the same input " +
			"plus the planHash. GavelUp messages no one.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx, args.clubId);
		const guestId = args.guestId.toLowerCase();
		const memberId = args.memberId?.toLowerCase();

		const hashOf = (p: Plan) =>
			planHash({ tool: TOOL, clubId: club.clubId, userId: user.id, plan: p });
		const view = (p: Plan) => ({ clubId: club.clubId, ...p });

		const buildPlan = async (): Promise<Plan> => {
			const guest = (await loadGuestPipeline(club.clubId)).find(
				(g) => g.id === guestId,
			);
			if (!guest) throw new McpError("NOT_FOUND", GUEST_NOT_FOUND_MESSAGE);
			let member: Plan["member"] = null;
			if (memberId) {
				const [row] = await db
					.select({
						id: members.id,
						name: members.name,
						status: members.status,
					})
					.from(members)
					.where(and(eq(members.id, memberId), eq(members.clubId, club.clubId)))
					.limit(1);
				if (!row) throw new McpError("NOT_FOUND", MEMBER_NOT_FOUND_MESSAGE);
				member = row;
			}
			return planOf(guest, member, memberId !== undefined);
		};

		const p = await buildPlan();
		if (!args.planHash) {
			return { applied: false, plan: view(p), planHash: hashOf(p) };
		}
		if (hashOf(p) !== args.planHash) {
			throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
				plan: view(p),
				planHash: hashOf(p),
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
			if (memberId) {
				const r = await applyLinkGuestToMember({
					clubId: club.clubId,
					guestId,
					memberId,
					actorMemberId: club.membershipId,
				});
				return {
					applied: true,
					clubId: club.clubId,
					mode: p.mode,
					movedSlotCount: r.slotIds.length,
					plan: view(p),
				};
			}
			const r = await applyConvertGuestToMember({
				clubId: club.clubId,
				guestId,
				actorMemberId: club.membershipId,
			});
			return {
				applied: true,
				clubId: club.clubId,
				mode: p.mode,
				memberId: r.membershipId,
				reactivated: r.reactivated,
				demotedFrom: r.demotedFrom ?? null,
				closedOfficerPositions: r.closedOfficerPositions,
				plan: view(p),
				note: "GavelUp tells no one. Let the new member know yourself.",
			};
		} catch (e) {
			if (e instanceof Error) {
				if (KNOWN_REFUSALS.has(e.message)) {
					throw new McpError("BLOCKED", e.message, {
						blocking: [{ code: "CONVERT_REFUSED", message: e.message }],
					});
				}
				if (e.message === GUEST_NOT_IN_CLUB_MESSAGE) {
					throw new McpError("NOT_FOUND", GUEST_NOT_FOUND_MESSAGE);
				}
				if (e.message === RECORD_CHANGED_MESSAGE) {
					throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE);
				}
			}
			throw e;
		}
	},
};

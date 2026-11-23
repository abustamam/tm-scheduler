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
 * Creating a member previews through the app's OWN convert, run with its
 * `dryRun` option (a private sentinel thrown inside the writer's transaction, so
 * every write rolls back): the plan says whether a new member is made or an
 * existing membership reused, and for a reuse whether it is reactivated, its
 * admin role demoted and which officer terms close. A refusal that run gives
 * (a roster name clash) is a `blocking` item with the app's sentence. Linking
 * has no dry run and stays read-only queries (stage, pointer, member status).
 * A KNOWN refusal sentence thrown at apply maps to `BLOCKED`, a changed record
 * to `PLAN_STALE`, anything else propagates as INTERNAL.
 *
 * Staleness: the plan hash covers the guest and member rows as the plan shows
 * them plus their RAW email and phone (the plan shows masked forms, and two
 * different addresses can mask the same; see `guest-book-plan.ts`), so a stage change, a new visit or a slot assigned changes it. Apply
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
import { members, people } from "#/db/schema";
import {
	CONVERT_NAME_CLASH_MESSAGE,
	LINK_ALREADY_JOINED_MESSAGE,
	LINK_MEMBER_NOT_IN_CLUB_MESSAGE,
} from "#/lib/guest-convert";
import { planHash } from "#/lib/mcp-plan";
import {
	applyConvertGuestToMember,
	applyLinkGuestToMember,
	type ConvertGuestResult,
	GUEST_ALREADY_CONVERTED_MESSAGE,
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
const KNOWN_REFUSALS = new Set<string>([
	LINK_ALREADY_JOINED_MESSAGE,
	LINK_MEMBER_FORMER_MESSAGE,
	LINK_MEMBER_NOT_IN_CLUB_MESSAGE,
	CONVERT_NAME_CLASH_MESSAGE,
	GUEST_ALREADY_CONVERTED_MESSAGE,
]);

type MembershipOutcome =
	| { kind: "new_member" }
	| {
			kind: "reuse_existing_membership";
			membershipId: string;
			name: string;
			/** Its status and role BEFORE the convert. */
			priorStatus: string;
			priorClubRole: string;
			reactivatedFrom: "inactive" | "former" | null;
			priorEndedAt: string | null;
			demotedFrom: "admin" | null;
			closedOfficerPositions: string[];
	  };

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
	/**
	 * Create mode only (null when linking): what the app's own convert would do
	 * to the roster, from a rolled-back run of that writer. A reused membership
	 * is the case an officer most needs to see: a lapsed one is woken, an
	 * admin's role is set back to member and open officer terms are closed.
	 */
	membership: MembershipOutcome | null;
	carriesOver: string[];
	doesNotCarryOver: string[];
	blocking: { code: string; message: string }[];
}

function planOf(
	g: PipelineGuestRow,
	member: { id: string; name: string; status: string } | null,
	linking: boolean,
	membership: MembershipOutcome | null,
	refusal: string | null,
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
			message: GUEST_ALREADY_CONVERTED_MESSAGE,
		});
	}
	// The app's own refusal from the rolled-back convert (a name clash).
	if (refusal) blocking.push({ code: "CONVERT_REFUSED", message: refusal });
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
		membership,
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

		interface Built {
			plan: Plan;
			/** Raw contact (never returned): the plan shows masked forms only. */
			raw: unknown;
		}
		const hashOf = (b: Built) =>
			planHash({
				tool: TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan: { shown: b.plan, rawContact: b.raw },
			});
		const withClub = (p: Plan) => ({ clubId: club.clubId, ...p });

		const personContact = async (personId: string | null) => {
			if (!personId) return null;
			const [row] = await db
				.select({ email: people.email, phone: people.phone })
				.from(people)
				.where(eq(people.id, personId))
				.limit(1);
			return row ?? null;
		};

		/** The app's own convert, run and rolled back; null when it refused. */
		const dryRunConvert = async (): Promise<
			{ result: ConvertGuestResult } | { refusal: string }
		> => {
			try {
				return {
					result: await applyConvertGuestToMember(
						{ clubId: club.clubId, guestId, actorMemberId: club.membershipId },
						{ dryRun: true },
					),
				};
			} catch (e) {
				if (e instanceof Error) {
					if (KNOWN_REFUSALS.has(e.message)) return { refusal: e.message };
					if (e.message === GUEST_NOT_IN_CLUB_MESSAGE) {
						throw new McpError("NOT_FOUND", GUEST_NOT_FOUND_MESSAGE);
					}
					if (e.message === RECORD_CHANGED_MESSAGE) {
						throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE);
					}
				}
				throw e;
			}
		};

		const buildPlan = async (): Promise<Built> => {
			const guest = (await loadGuestPipeline(club.clubId)).find(
				(g) => g.id === guestId,
			);
			if (!guest) throw new McpError("NOT_FOUND", GUEST_NOT_FOUND_MESSAGE);
			let member: Plan["member"] = null;
			let memberPersonId: string | null = null;
			if (memberId) {
				const [row] = await db
					.select({
						id: members.id,
						name: members.name,
						status: members.status,
						personId: members.personId,
					})
					.from(members)
					.where(and(eq(members.id, memberId), eq(members.clubId, club.clubId)))
					.limit(1);
				if (!row) throw new McpError("NOT_FOUND", MEMBER_NOT_FOUND_MESSAGE);
				member = { id: row.id, name: row.name, status: row.status };
				memberPersonId = row.personId;
			}
			let membership: MembershipOutcome | null = null;
			let refusal: string | null = null;
			let reusedPersonId: string | null = null;
			// A joined guest is refused by the stage check in `planOf`; the dry run
			// would only repeat it.
			if (!memberId && guest.stage !== "joined") {
				const dry = await dryRunConvert();
				if ("refusal" in dry) {
					refusal = dry.refusal;
				} else {
					const r = dry.result;
					// The run rolled back, so a membership that still exists under this
					// id is one the convert REUSED, and this read is its state before.
					const [prior] = await db
						.select({
							id: members.id,
							name: members.name,
							status: members.status,
							clubRole: members.clubRole,
						})
						.from(members)
						.where(
							and(
								eq(members.id, r.membershipId),
								eq(members.clubId, club.clubId),
							),
						)
						.limit(1);
					if (prior) {
						reusedPersonId = r.personId;
						membership = {
							kind: "reuse_existing_membership",
							membershipId: prior.id,
							name: prior.name,
							priorStatus: prior.status,
							priorClubRole: prior.clubRole,
							reactivatedFrom: r.reactivatedFrom ?? null,
							priorEndedAt: r.priorEndedAt ?? null,
							demotedFrom: r.demotedFrom ?? null,
							closedOfficerPositions: r.closedOfficerPositions,
						};
					} else {
						membership = { kind: "new_member" };
					}
				}
			}
			return {
				plan: planOf(
					guest,
					member,
					memberId !== undefined,
					membership,
					refusal,
				),
				raw: {
					guest: {
						email: guest.email,
						typedNote: guest.bookEmail ?? null,
						phone: guest.phone,
						phoneRaw: guest.phoneRaw,
					},
					member: await personContact(memberPersonId ?? reusedPersonId),
				},
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
					plan: withClub(p),
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
				plan: withClub(p),
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

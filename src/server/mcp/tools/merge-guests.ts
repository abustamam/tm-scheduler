/**
 * `merge_guests` — an officer folds one duplicate guest record into another
 * (#1664). The connector's twin of the guest board's "Merge" action, writing
 * through THE SAME WRITER (`applyMergeGuests`, #1609) in its own transaction
 * and lock order. This file never reimplements the merge.
 *
 * The preview is the app's own dry run (`previewMergeGuests`, a rolled-back
 * `applyMergeGuests`), so the counts it shows are the apply's. Beside them it
 * names both records the way `find_people` does (masked contact, stage, visit
 * count), so the officer sees WHO is being folded into whom.
 *
 * Blocking items are `{ code, message }` with codes local to this tool. A
 * refusal the app's preview gives (the same guest twice, a converted guest, two
 * different people, a person-linked guest) is one `MERGE_REFUSED` item carrying
 * the app's own sentence; apply then returns `BLOCKED`.
 *
 * Staleness: the plan hash covers both records as the plan shows them and every
 * count the dry run returned. Apply re-plans and compares hashes BEFORE calling
 * the app's merge. `applyMergeGuests` takes no freshness hook, so a change
 * committed between that comparison and the merge's own locks is not caught
 * here; the merge re-reads under its locks and refuses the cases that make it
 * unsafe (`RECORD_CHANGED_MESSAGE`, which this tool reports as `PLAN_STALE`).
 *
 * Authorization: `audience: "officer"` through `authorizeToken`; the app's merge
 * asks for admin standing again under its locks. Both ids are looked up inside
 * the token's club, so another club's guest is NOT_FOUND.
 */
import { z } from "zod";
import { planHash } from "#/lib/mcp-plan";
import {
	applyMergeGuests,
	GUEST_MERGE_CONVERTED_MESSAGE,
	GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
	GUEST_MERGE_PERSON_LINKED_MESSAGE,
	GUEST_MERGE_SAME_MESSAGE,
	type MergeGuestsPreview,
	previewMergeGuests,
} from "#/server/guest-merge-logic";
import {
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

const TOOL = "merge_guests";

const inputSchema = {
	clubId: z.string().uuid(),
	keepGuestId: z
		.string()
		.uuid()
		.describe("The guest record that stays, from find_people."),
	absorbGuestId: z
		.string()
		.uuid()
		.describe(
			"The duplicate guest record folded into the kept one and then deleted, from find_people.",
		),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

export const GUEST_NOT_FOUND_MESSAGE =
	"One of those guests is not in this club. find_people lists the club's guests.";
export const PLAN_STALE_MESSAGE =
	"One of the guests changed since you previewed this. Review the fresh plan and ask the user again.";
export const IRREVERSIBLE_NOTE =
	"This cannot be undone: the absorbed guest record is deleted.";

const REFUSALS = new Set([
	GUEST_MERGE_SAME_MESSAGE,
	GUEST_MERGE_CONVERTED_MESSAGE,
	GUEST_MERGE_DIFFERENT_PEOPLE_MESSAGE,
	GUEST_MERGE_PERSON_LINKED_MESSAGE,
]);

interface GuestView {
	id: string;
	name: string;
	preferredName: string | null;
	emailMasked: string | null;
	phoneMasked: string | null;
	stage: string;
	visitCount: number;
}

interface Plan {
	keep: GuestView;
	absorb: GuestView;
	/** Rows the merge re-points to the kept guest, per table. */
	moved: Record<string, number>;
	/** Rows dropped because the kept guest already has the same one, per table. */
	droppedAsDuplicate: Record<string, number>;
	absorbedPersonDeleted: boolean;
	note: string;
	blocking: { code: string; message: string }[];
}

function viewOf(g: PipelineGuestRow): GuestView {
	const m = toMcpGuest(g);
	return {
		id: g.id,
		name: m.name,
		preferredName: m.preferredName,
		emailMasked: m.emailMasked,
		phoneMasked: m.phoneMasked,
		stage: g.stage,
		visitCount: g.visitCount,
	};
}

/** Counts with zeros left out, so the plan names only tables that change. */
const nonZero = (c: Record<string, number>) =>
	Object.fromEntries(Object.entries(c).filter(([, n]) => n > 0));

export const mergeGuestsTool: McpToolDefinition = {
	name: TOOL,
	audience: "officer",
	// It deletes the absorbed guest record and a second call does not undo it.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Merge two duplicate guest records",
		description:
			"Fold one duplicate guest record into another of the same club, as a " +
			"club admin would on the guest board: the absorbed guest's visits, " +
			"slots, RSVPs, speeches and other records move to the kept guest and " +
			"the absorbed record is deleted. IRREVERSIBLE. Ids from find_people. " +
			"Refused for the same guest twice, a guest who has become a member, " +
			"two guests who are different people in the system, and a guest with " +
			"a speech or enrolment on their person record. Call once WITHOUT " +
			"planHash to preview: it writes nothing, shows both records (masked " +
			"contact, stage, visit count), the rows that move per table, and any " +
			"refusal, and returns a planHash. Show the plan to the user in full; " +
			"after they agree, call again with the same input plus the planHash. " +
			"GavelUp messages no one.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx, args.clubId);
		const keepGuestId = args.keepGuestId.toLowerCase();
		const absorbGuestId = args.absorbGuestId.toLowerCase();
		const merge = {
			clubId: club.clubId,
			keepGuestId,
			absorbGuestId,
			actorUserId: user.id,
		};

		const hashOf = (p: Plan) =>
			planHash({ tool: TOOL, clubId: club.clubId, userId: user.id, plan: p });
		const view = (p: Plan) => ({ clubId: club.clubId, ...p });

		const buildPlan = async (): Promise<Plan> => {
			const guests = await loadGuestPipeline(club.clubId);
			const keep = guests.find((g) => g.id === keepGuestId);
			const absorb = guests.find((g) => g.id === absorbGuestId);
			if (keepGuestId === absorbGuestId) {
				const only = keep ?? absorb;
				if (!only) throw new McpError("NOT_FOUND", GUEST_NOT_FOUND_MESSAGE);
				return {
					keep: viewOf(only),
					absorb: viewOf(only),
					moved: {},
					droppedAsDuplicate: {},
					absorbedPersonDeleted: false,
					note: IRREVERSIBLE_NOTE,
					blocking: [
						{ code: "MERGE_REFUSED", message: GUEST_MERGE_SAME_MESSAGE },
					],
				};
			}
			if (!keep || !absorb) {
				throw new McpError("NOT_FOUND", GUEST_NOT_FOUND_MESSAGE);
			}
			let dry: MergeGuestsPreview;
			try {
				dry = await previewMergeGuests(merge);
			} catch (e) {
				if (e instanceof Error && e.message === RECORD_CHANGED_MESSAGE) {
					throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE);
				}
				throw e;
			}
			return {
				keep: viewOf(keep),
				absorb: viewOf(absorb),
				moved: nonZero(dry.moved),
				droppedAsDuplicate: nonZero(dry.droppedAsDuplicate),
				absorbedPersonDeleted: dry.absorbedPersonDeleted,
				note: IRREVERSIBLE_NOTE,
				blocking: dry.refusal
					? [{ code: "MERGE_REFUSED", message: dry.refusal }]
					: [],
			};
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
			await applyMergeGuests(merge);
		} catch (e) {
			if (e instanceof Error) {
				if (REFUSALS.has(e.message)) {
					throw new McpError("BLOCKED", e.message, {
						blocking: [{ code: "MERGE_REFUSED", message: e.message }],
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
		return {
			applied: true,
			clubId: club.clubId,
			keptGuestId: keepGuestId,
			absorbedGuestId: absorbGuestId,
			plan: view(p),
		};
	},
};

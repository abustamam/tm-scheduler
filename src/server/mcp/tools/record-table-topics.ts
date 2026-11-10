/**
 * `record_table_topics` — add, remove and reorder who spoke in a meeting's
 * table topics (#1575), the Ballot Counter console's list, by asking.
 *
 * Authorization is the meeting's `voteCounter` capability
 * (`authorizeDelegateForMeeting`, #1567): an officer, the meeting's Ballot
 * Counter or its Toastmaster, the three the app lets write this list.
 *
 * ## One code path for preview and apply
 *
 * The steps run through the app's OWN cores (`addTableTopicsSpeaker`,
 * `removeTableTopicsSpeaker`, `moveTableTopicsSpeaker`), handed one
 * transaction, so the tool never writes a second insert. A preview runs them and
 * ROLLS BACK (a sentinel thrown out of the transaction), so it writes nothing and
 * shows what an apply would produce, including a new guest it would create. An
 * apply runs them again under the meeting's slot-edit lock, compares the hash of
 * what it built with the hash it was given, and either commits or throws
 * (`PLAN_STALE`, `BLOCKED`), which rolls every step back.
 *
 * Steps run in a fixed order: `remove`, then `add`, then `move`. A `move`'s
 * `toIndex` is a 0-based place in the list AFTER the removes and adds.
 *
 * ## Never choosing
 *
 * A `newGuest` whose name is close to a guest or member of the club is
 * `ambiguous` and skipped unless its index is in `confirmNew` (the `add_members`
 * rule: the USER says it is someone new). `confirmNew` is part of the plan, so
 * confirming changes the hash.
 *
 * ## Meeting state follows the app
 *
 * These are record writes: a cancelled meeting is refused, a completed one is
 * accepted (minutes are written after the meeting). `throwIfLocked` is not used.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, guests, members } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import { planHash } from "#/lib/mcp-plan";
import { assertMeetingAccepts, meetingRefusal } from "#/lib/meeting-lifecycle";
import { matchTier } from "#/lib/person-search";
import { isMemberUnavailable } from "#/server/attendance-plan-logic";
import { lockMeetingForSlotEdit } from "#/server/meeting-slot-lock";
import {
	addTableTopicsSpeaker,
	loadTableTopicsList,
	moveTableTopicsSpeaker,
	removeTableTopicsSpeaker,
} from "#/server/minutes-logic";
import { authorizeDelegateForMeeting } from "../authz-logic";
import { type McpBlockingItem, McpError } from "../errors";
import type { DbOrTx } from "../member-meeting";
import type { McpToolDefinition } from "../tool";
import { recordRefusalItem } from "./set-awards";

export const RECORD_TABLE_TOPICS_TOOL = "record_table_topics";

const MAX_ENTRIES = 50;
const MAX_MATCHES = 3;

const PLAN_STALE_MESSAGE =
	"This meeting's table topics list (or what you confirmed in confirmNew) changed since that preview. Show the user the fresh plan and ask again.";

const topic = z.string().trim().max(500).optional();

const addSchema = z.union([
	z.object({ memberId: z.string().uuid().toLowerCase(), topic }).strict(),
	z.object({ guestId: z.string().uuid().toLowerCase(), topic }).strict(),
	z
		.object({
			newGuest: z.object({ name: z.string().trim().min(1).max(200) }).strict(),
			topic,
		})
		.strict(),
]);

const moveSchema = z
	.object({
		id: z.string().uuid().toLowerCase(),
		toIndex: z
			.number()
			.int()
			.min(0)
			.max(MAX_ENTRIES * 2),
	})
	.strict();

const inputSchema = {
	meetingId: z.string().uuid(),
	add: z
		.array(addSchema)
		.max(MAX_ENTRIES)
		.optional()
		.describe(
			"Speakers to append, in order: each exactly one of {memberId}, " +
				"{guestId} or {newGuest: {name}}, plus an optional topic. Ids come " +
				"from get_agenda or find_people.",
		),
	remove: z
		.array(z.string().uuid().toLowerCase())
		.max(MAX_ENTRIES)
		.optional()
		.describe(
			"Speaker row ids to remove: plan.before[].id in a preview (an officer " +
				"also has get_agenda's tableTopicsSpeakers[].id).",
		),
	move: z
		.array(moveSchema)
		.max(MAX_ENTRIES)
		.optional()
		.describe(
			"[{id, toIndex}] applied in order, after remove and add: put that " +
				"speaker at the 0-based place toIndex.",
		),
	confirmNew: z
		.array(
			z
				.number()
				.int()
				.min(0)
				.max(MAX_ENTRIES - 1),
		)
		.max(MAX_ENTRIES)
		.optional()
		.describe(
			"Indexes into add of newGuest entries the USER confirmed are new " +
				"people. Never fill this on your own.",
		),
	planHash: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply that plan.",
		),
};

type Args = z.infer<z.ZodObject<typeof inputSchema>>;
type AddEntry = z.infer<typeof addSchema>;

type Line = {
	position: number;
	kind: "member" | "guest";
	name: string;
	topic: string | null;
};

type AddRow = {
	index: number;
	kind: "member" | "guest" | "newGuest";
	name: string;
	topic: string | null;
	verdict: "would_add" | "ambiguous";
	/** Ambiguous only: the call listed this entry in `confirmNew`. */
	confirmed: boolean;
	/** How many guests and members of the club this newGuest is close to. */
	matchCount: number;
	/** Names of those matches. Managers only: a non-manager delegate gets the
	 *  count above and an empty list, so the preview cannot be used to probe the
	 *  club's visitors (the web shows guest names to managers only). */
	possibleMatches: { name: string }[];
};

type Plan = {
	meetingId: string;
	status: string;
	request: {
		remove: string[];
		add: AddEntry[];
		move: z.infer<typeof moveSchema>[];
		confirmNew: number[];
	};
	before: (Line & { id: string })[];
	adds: AddRow[];
	after: Line[];
	blocking: McpBlockingItem[];
};

type MeetingRow = { id: string; clubId: string; status: string };

const fold = (s: string) => s.trim().toLowerCase();
const wordsOf = (s: string | null | undefined) =>
	fold(s ?? "")
		.split(/\s+/)
		.filter((w) => w.length >= 2);

/** The `add_members` closeness rule: prefix/substring either way, or a shared
 *  whole word. Never fuzzy. */
function isClose(
	name: string,
	other: { name: string; preferredName?: string | null },
): boolean {
	if (
		matchTier(name, other) !== null ||
		matchTier(other.name, { name }) !== null
	) {
		return true;
	}
	const mine = new Set(wordsOf(name));
	return [...wordsOf(other.name), ...wordsOf(other.preferredName)].some((w) =>
		mine.has(w),
	);
}

const asLine = (r: {
	position: number;
	memberId: string | null;
	name: string;
	topic: string | null;
}): Line => ({
	position: r.position,
	kind: r.memberId ? "member" : "guest",
	name: r.name,
	topic: r.topic,
});

/**
 * Run the request's steps on `tx` and describe the result. Writes whatever the
 * steps write: the caller either commits (apply) or rolls back (preview).
 */
async function runSteps(
	tx: DbOrTx,
	meeting: MeetingRow,
	args: Args,
	/** An officer or admin: sees the names of matches. A Ballot Counter or
	 *  Toastmaster does not (see `AddRow.possibleMatches`). */
	manager: boolean,
): Promise<Plan> {
	const request: Plan["request"] = {
		remove: args.remove ?? [],
		add: args.add ?? [],
		move: args.move ?? [],
		confirmNew: [...new Set(args.confirmNew ?? [])].sort((a, b) => a - b),
	};
	const beforeRows = await loadTableTopicsList(tx, meeting.id);
	const blocking: McpBlockingItem[] = [];
	const adds: AddRow[] = [];
	const plan = (after: Line[]): Plan => ({
		meetingId: meeting.id,
		status: meeting.status,
		request,
		before: beforeRows.map((r) => ({ id: r.id, ...asLine(r) })),
		adds,
		after,
		blocking,
	});
	const beforeLines = beforeRows.map(asLine);

	for (const i of request.confirmNew) {
		const entry = request.add[i];
		if (!entry || !("newGuest" in entry)) {
			throw new McpError(
				"VALIDATION",
				`confirmNew index ${i} does not point at a newGuest entry of add.`,
			);
		}
	}

	// The write class's own policy: a status it refuses (cancelled) is refused
	// here with that status's sentence.
	const refused = meetingRefusal(meeting.status, "record");
	if (refused !== null) {
		blocking.push(recordRefusalItem(refused));
		return plan(beforeLines);
	}

	// --- remove -------------------------------------------------------------
	// An id not on the list is a blocking item, not a thrown error: an id the
	// preview listed and another writer deleted since then must reach the hash
	// comparison (PLAN_STALE with the fresh plan), not fail as a bad request.
	const present = new Set(beforeRows.map((r) => r.id));
	for (const [entryIndex, id] of request.remove.entries()) {
		if (!present.has(id)) {
			blocking.push({
				code: "SLOT_NOT_IN_MEETING",
				entryIndex,
				message:
					"A remove id is not a table topics speaker of this meeting. Ids are in the preview's plan.before list (get_agenda's tableTopicsSpeakers for an officer).",
				detail: { id, step: "remove" },
			});
		}
	}
	for (const id of new Set(request.remove)) {
		if (present.has(id)) {
			await removeTableTopicsSpeaker({ meetingId: meeting.id, id }, tx);
		}
	}

	// --- add ----------------------------------------------------------------
	const memberIds = request.add.flatMap((a) =>
		"memberId" in a ? [a.memberId] : [],
	);
	const guestIds = request.add.flatMap((a) =>
		"guestId" in a ? [a.guestId] : [],
	);
	const [memberRows, guestRows] = await Promise.all([
		memberIds.length > 0
			? tx
					.select({ id: members.id, name: members.name })
					.from(members)
					.where(
						and(
							inArray(members.id, memberIds),
							eq(members.clubId, meeting.clubId),
						),
					)
			: Promise.resolve([]),
		guestIds.length > 0
			? tx
					.select({ id: guests.id, name: guests.name })
					.from(guests)
					.where(
						and(
							inArray(guests.id, guestIds),
							eq(guests.clubId, meeting.clubId),
						),
					)
			: Promise.resolve([]),
	]);
	const memberById = new Map(memberRows.map((r) => [r.id, r]));
	const guestById = new Map(guestRows.map((r) => [r.id, r]));
	// Only read when a newGuest is present: the club's people to compare against.
	const hasNewGuest = request.add.some((a) => "newGuest" in a);
	// Read in a fixed order (name, then id): the matches are cut to MAX_MATCHES
	// and hashed, so an unordered read could re-order them and raise a spurious
	// PLAN_STALE.
	const roster = hasNewGuest
		? await tx
				.select({ name: members.name, preferredName: members.preferredName })
				.from(members)
				.where(eq(members.clubId, meeting.clubId))
				.orderBy(asc(members.name), asc(members.id))
		: [];
	const clubGuests: { name: string }[] = hasNewGuest
		? await tx
				.select({ name: guests.name })
				.from(guests)
				.where(eq(guests.clubId, meeting.clubId))
				.orderBy(asc(guests.name), asc(guests.id))
		: [];
	const confirmed = new Set(request.confirmNew);

	for (const [index, entry] of request.add.entries()) {
		const entryTopic = entry.topic?.trim() || null;
		if ("memberId" in entry) {
			const m = memberById.get(entry.memberId);
			if (!m) {
				blocking.push({
					code: "NOT_A_MEMBER",
					entryIndex: index,
					message:
						"That member is not on this club's roster. find_people lists who can be recorded.",
					detail: { memberId: entry.memberId },
				});
				continue;
			}
			if (
				await isMemberUnavailable(tx, {
					memberId: entry.memberId,
					meetingId: meeting.id,
				})
			) {
				throw new McpError(
					"VALIDATION",
					`${m.name} is not available for this meeting.`,
				);
			}
			adds.push({
				index,
				kind: "member",
				name: m.name,
				topic: entryTopic,
				verdict: "would_add",
				confirmed: false,
				matchCount: 0,
				possibleMatches: [],
			});
			await addTableTopicsSpeaker(
				{ meetingId: meeting.id, memberId: entry.memberId, topic: entryTopic },
				tx,
			);
		} else if ("guestId" in entry) {
			const g = guestById.get(entry.guestId);
			if (!g) {
				blocking.push({
					code: "NOT_A_GUEST",
					entryIndex: index,
					message:
						"No guest with that id in this club. A guest staged by record_guest_book exists only once its confirm page is applied; for someone new use newGuest.",
					detail: { guestId: entry.guestId },
				});
				continue;
			}
			adds.push({
				index,
				kind: "guest",
				name: g.name,
				topic: entryTopic,
				verdict: "would_add",
				confirmed: false,
				matchCount: 0,
				possibleMatches: [],
			});
			await addTableTopicsSpeaker(
				{ meetingId: meeting.id, guestId: entry.guestId, topic: entryTopic },
				tx,
			);
		} else {
			const name = entry.newGuest.name.trim();
			// `clubGuests` also holds the newGuests this call already created, so two
			// close names in one add are ambiguous against each other.
			const close = [...roster, ...clubGuests].filter((o) => isClose(name, o));
			const ambiguous = close.length > 0;
			const isConfirmed = ambiguous && confirmed.has(index);
			adds.push({
				index,
				kind: "newGuest",
				name,
				topic: entryTopic,
				verdict: ambiguous ? "ambiguous" : "would_add",
				confirmed: isConfirmed,
				matchCount: close.length,
				// Names only for a manager. The web lists the club's guests to
				// managers only (loadMeetingDetail's canManage, listGuests), and it
				// lists the roster to managers only too, so a plain delegate gets
				// the count, never a name.
				possibleMatches: manager
					? close.slice(0, MAX_MATCHES).map((o) => ({ name: o.name }))
					: [],
			});
			if (ambiguous && !isConfirmed) continue;
			await addTableTopicsSpeaker(
				{ meetingId: meeting.id, newGuest: { name }, topic: entryTopic },
				tx,
			);
			clubGuests.push({ name });
		}
	}

	// --- move ---------------------------------------------------------------
	for (const [entryIndex, mv] of request.move.entries()) {
		const now = await loadTableTopicsList(tx, meeting.id);
		if (!now.some((r) => r.id === mv.id)) {
			blocking.push({
				code: "SLOT_NOT_IN_MEETING",
				entryIndex,
				message: `move entry ${entryIndex} names a speaker that is not on the list (never in it, removed in this call, or deleted since the preview).`,
				detail: { id: mv.id, step: "move" },
			});
			continue;
		}
		if (mv.toIndex >= now.length) {
			throw new McpError(
				"VALIDATION",
				`move entry ${entryIndex} has toIndex ${mv.toIndex}, but the list has ${now.length} speakers after the removes and adds (0 to ${now.length - 1}).`,
			);
		}
		await moveTableTopicsSpeaker(
			{
				meetingId: meeting.id,
				id: mv.id,
				// Ignored: `toIndex` is absolute and wins over `direction`.
				direction: "down",
				toIndex: mv.toIndex,
			},
			tx,
		);
	}

	return plan((await loadTableTopicsList(tx, meeting.id)).map(asLine));
}

function summarize(plan: Plan): string {
	const landed = plan.adds.filter(
		(a) => a.verdict === "would_add" || a.confirmed,
	).length;
	const skipped = plan.adds.filter(
		(a) => a.verdict === "ambiguous" && !a.confirmed,
	).length;
	const parts = [
		plan.request.remove.length > 0
			? `${new Set(plan.request.remove).size} removed`
			: null,
		landed > 0 ? `${landed} added` : null,
		skipped > 0 ? `${skipped} ambiguous, skipped until confirmed` : null,
		plan.request.move.length > 0
			? `${plan.request.move.length} move${plan.request.move.length === 1 ? "" : "s"}`
			: null,
	].filter((p) => p !== null);
	return `${parts.join(", ") || "No changes"} (${plan.after.length} speaker${plan.after.length === 1 ? "" : "s"} after)`;
}

/** Thrown out of a preview's transaction so it rolls back; carries the plan. */
class PreviewRollback extends Error {
	constructor(readonly plan: Plan) {
		super("preview rollback");
	}
}

export const recordTableTopicsTool: McpToolDefinition = {
	name: RECORD_TABLE_TOPICS_TOOL,
	audience: "member",
	// Removes rows. Not idempotent: applying the same add twice adds twice.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Record table topics speakers",
		description:
			"For a meeting's officer, Ballot Counter or Toastmaster. Add, remove " +
			"and reorder who spoke in table topics, in order, each with an " +
			"optional topic. add takes {memberId}, {guestId} or {newGuest:{name}} " +
			"entries; remove takes speaker row ids and move takes {id, toIndex}, " +
			"both from plan.before[].id in a preview (get_agenda is officer-only). Steps run remove, then " +
			"add, then move. Without planHash this writes nothing: it returns the " +
			"list before and after, a planHash and any blocking items. Show it to " +
			"the user; call again with the same input plus that planHash to apply. " +
			"A newGuest whose name is close to a guest or member of the club is " +
			"ambiguous (a Ballot Counter or Toastmaster sees how many matches, an " +
			"officer sees their names) and NOT added unless the user confirms it is someone new " +
			"and you pass its index in confirmNew (preview again, then apply with " +
			"the new planHash). All steps apply or none do. A cancelled meeting is " +
			"refused; a completed one is accepted. For the Best Table Topics " +
			"winner use set_awards.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		if (
			(args.add ?? []).length === 0 &&
			(args.remove ?? []).length === 0 &&
			(args.move ?? []).length === 0
		) {
			throw new McpError(
				"VALIDATION",
				"Give at least one of add, remove or move.",
			);
		}
		const { club, user, via } = await authorizeDelegateForMeeting(
			ctx,
			args.meetingId,
			"voteCounter",
		);
		const manager = via === "admin";
		const hashOf = (plan: Plan) =>
			planHash({
				tool: RECORD_TABLE_TOPICS_TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan,
			});

		if (args.planHash === undefined) {
			let plan: Plan;
			try {
				await db.transaction(async (tx) => {
					const meeting = await lockMeetingForSlotEdit(tx, args.meetingId);
					throw new PreviewRollback(await runSteps(tx, meeting, args, manager));
				});
				throw new Error("unreachable: a preview always rolls back");
			} catch (err) {
				if (!(err instanceof PreviewRollback)) throw err;
				plan = err.plan;
			}
			return {
				applied: false,
				meetingId: args.meetingId,
				clubId: club.clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
				blocking: plan.blocking,
			};
		}

		const expected = args.planHash;
		const result = await db.transaction(async (tx) => {
			const meeting = await lockMeetingForSlotEdit(tx, args.meetingId);
			// The archive gate UNDER the lock: authorization read it before the
			// transaction, and the club may have been archived since.
			const [clubRow] = await tx
				.select({ archivedAt: clubs.archivedAt })
				.from(clubs)
				.where(eq(clubs.id, meeting.clubId))
				.limit(1);
			if (!clubRow) throw new McpError("NOT_FOUND", "Club not found.");
			if (isClubArchived(clubRow)) {
				throw new McpError("ARCHIVED", CLUB_ARCHIVED_MESSAGE);
			}
			// Throwing from here on rolls back every step already run.
			const plan = await runSteps(tx, meeting, args, manager);
			const freshHash = hashOf(plan);
			if (freshHash !== expected) {
				throw new McpError("PLAN_STALE", PLAN_STALE_MESSAGE, {
					plan,
					planHash: freshHash,
					summary: summarize(plan),
				});
			}
			if (plan.blocking.length > 0) {
				throw new McpError(
					"BLOCKED",
					`Nothing was changed — ${plan.blocking.length} problem${plan.blocking.length === 1 ? "" : "s"} to fix first.`,
					{ blocking: plan.blocking },
				);
			}
			// The enforcement, apart from the blocking item above: it throws for any
			// status the "record" class refuses, so a status `runSteps` missed still
			// stops the call as an error rather than a silent success. It is the
			// call `meeting-writers.guard.test.ts` reads as this tool's refusal.
			assertMeetingAccepts(meeting.status, "record");
			return { plan, list: await loadTableTopicsList(tx, meeting.id) };
		});

		return {
			applied: true,
			meetingId: args.meetingId,
			clubId: club.clubId,
			summary: summarize(result.plan),
			plan: result.plan,
			// Read back from what is now stored, with the new rows' ids.
			tableTopicsSpeakers: result.list,
		};
	},
};

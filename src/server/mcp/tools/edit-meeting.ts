/**
 * `edit_meeting` — patch a meeting's text fields from the connector (#1574,
 * epic #1560).
 *
 * Six fields of a meeting could not be written from the connector at all (join
 * link, notes, announcements, table topics notes, promo note, meeting number),
 * and the people who own several of them on the night, the Toastmaster, the
 * Grammarian and the Table Topics Master, had no tool. This is the one tool for
 * all of them, through the app's three writers, with each field allowed to the
 * same people the app allows.
 *
 * ## Who may change what (the web resolvers' rules, per field)
 *
 *   - `theme`, `location`, `joinUrl`, `notes`, `reminders`: an officer or the
 *     Toastmaster (the `agenda` capability).
 *   - `wordOfTheDay`, `wodDefinition`, `wodExample`: an officer, the Toastmaster
 *     or the Grammarian (`wordOfTheDay`).
 *   - `tableTopicsNotes`: an officer, the Toastmaster or the Table Topics Master
 *     (`tableTopicsNotes`).
 *   - `promoNote`, `meetingNumber`: an officer only.
 *
 * A call is allowed only if EVERY field it sends is allowed to the caller. A
 * field the caller may not change is a `blocking` entry in the preview, and the
 * apply is `BLOCKED` and writes nothing: no partial write.
 *
 * ## Writers
 *
 * An officer or Toastmaster goes through `applyMeetingMetaPatch` (the
 * Toastmaster with `canReschedule: false`, so the writer's own refusal of
 * `meetingNumber` and `promoNote` also holds). A caller whose only grants are the
 * Grammarian's and/or the Table Topics Master's goes through
 * `applyWodAndTableTopicsUpdate`, the one combined narrow writer (a Grammarian
 * and a TTM call alike, so a call logs exactly one `meeting_edit`). All run in
 * this tool's transaction, under the meeting row's lock.
 *
 * The date, time and length are `reschedule_meeting`'s.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { clubs, meetings } from "#/db/schema";
import { CLUB_ARCHIVED_MESSAGE, isClubArchived } from "#/lib/club-archive";
import { planHash } from "#/lib/mcp-plan";
import { JOIN_URL_FIELD, MEETING_FIELDS } from "#/lib/meeting-limits";
import { normalizePresentationUrl } from "#/lib/presentation-url";
import { PROMO_LIMITS } from "#/lib/promo-template";
import { WOD_FIELDS } from "#/lib/wod-limits";
import {
	applyMeetingMetaPatch,
	applyWodAndTableTopicsUpdate,
} from "#/server/meetings-logic";
import { isUniqueViolation } from "#/server/pg-errors";
import {
	authorizeDelegateForMeeting,
	type DelegateCapability,
	NOT_ROLE_HOLDER_MESSAGE,
} from "../authz-logic";
import { McpError } from "../errors";
import type { DbOrTx } from "../member-meeting";
import type { McpToolDefinition } from "../tool";

export const EDIT_MEETING_TOOL = "edit_meeting";

export const NOTHING_TO_CHANGE_MESSAGE =
	"Send at least one field to change. The date, time and length are reschedule_meeting's.";
export const MEETING_NOT_EDITABLE_MESSAGE =
	"This meeting is cancelled or completed, so its details can no longer be edited.";
export const MEETING_NUMBER_TAKEN_MESSAGE =
	"Another meeting of this club already has that meeting number.";
const STALE_PLAN_MESSAGE =
	"The meeting changed since that preview. Show the user the fresh plan and ask again.";

/** Every field this tool writes, in the order a plan lists them. */
const FIELDS = [
	"theme",
	"location",
	"joinUrl",
	"notes",
	"reminders",
	"wordOfTheDay",
	"wodDefinition",
	"wodExample",
	"tableTopicsNotes",
	"promoNote",
	"meetingNumber",
] as const;
type Field = (typeof FIELDS)[number];

type Group = "agenda" | "wordOfTheDay" | "tableTopicsNotes" | "officer";

const GROUP_OF: Record<Field, Group> = {
	theme: "agenda",
	location: "agenda",
	joinUrl: "agenda",
	notes: "agenda",
	reminders: "agenda",
	wordOfTheDay: "wordOfTheDay",
	wodDefinition: "wordOfTheDay",
	wodExample: "wordOfTheDay",
	tableTopicsNotes: "tableTopicsNotes",
	promoNote: "officer",
	meetingNumber: "officer",
};

const WHO_MAY: Record<Group, string> = {
	agenda: "an officer or the meeting's Toastmaster",
	wordOfTheDay: "an officer, the Toastmaster or the Grammarian",
	tableTopicsNotes: "an officer, the Toastmaster or the Table Topics Master",
	officer: "an officer",
};

const inputSchema = {
	meetingId: z.string().uuid(),
	theme: MEETING_FIELDS.theme.nullable().optional(),
	location: MEETING_FIELDS.location.nullable().optional(),
	joinUrl: JOIN_URL_FIELD.nullable()
		.optional()
		.describe("The video call link. A value that is not a link clears it."),
	notes: MEETING_FIELDS.notes.nullable().optional(),
	reminders: MEETING_FIELDS.reminders
		.nullable()
		.optional()
		.describe("The meeting's announcements."),
	wordOfTheDay: WOD_FIELDS.word.nullable().optional(),
	wodDefinition: WOD_FIELDS.definition.nullable().optional(),
	wodExample: WOD_FIELDS.example.nullable().optional(),
	tableTopicsNotes: MEETING_FIELDS.tableTopicsNotes.nullable().optional(),
	promoNote: z.string().trim().max(PROMO_LIMITS.note).nullable().optional(),
	meetingNumber: z.number().int().positive().nullable().optional(),
	planHash: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned to apply that plan.",
		),
};

type Value = string | number | null;
type Change = { from: Value; to: Value };

/** The shape of an `McpBlockingItem`, with its own code: `errors.ts` is not part
 *  of this change, so the code is local to this tool's plan. */
interface FieldBlocking {
	code: "FIELD_NOT_ALLOWED";
	field: Field;
	message: string;
}

interface EditPlan {
	meetingId: string;
	/** Only the fields whose stored value differs from what was sent. */
	changes: Partial<Record<Field, Change>>;
	/** Sent fields that already hold the sent value: not written. */
	unchanged: Field[];
	/** Sent fields the caller may not change. Non-empty means nothing is written. */
	blocking: FieldBlocking[];
}

/** What the caller's three probes allow. */
interface Grants {
	officer: boolean;
	agenda: boolean;
	wordOfTheDay: boolean;
	tableTopicsNotes: boolean;
}

function mayChange(grants: Grants, field: Field): boolean {
	const group = GROUP_OF[field];
	if (group === "officer") return grants.officer;
	return grants.officer || grants[group];
}

type Args = Partial<Record<Field, Value | undefined>>;

function normalize(field: Field, value: Value): Value {
	if (field === "meetingNumber") return value;
	if (field === "joinUrl") {
		return normalizePresentationUrl(value as string | null);
	}
	return (value as string | null)?.trim() || null;
}

async function buildPlan(
	conn: DbOrTx,
	meetingId: string,
	args: Args,
	grants: Grants,
	lock: boolean,
): Promise<EditPlan> {
	const base = conn
		.select()
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	const [meeting] = lock ? await base.for("update") : await base;
	if (!meeting) throw new McpError("NOT_FOUND", "Meeting not found.");
	if (meeting.status === "cancelled" || meeting.status === "completed") {
		throw new McpError("LOCKED", MEETING_NOT_EDITABLE_MESSAGE);
	}

	const changes: EditPlan["changes"] = {};
	const unchanged: Field[] = [];
	const blocking: FieldBlocking[] = [];
	for (const field of FIELDS) {
		const sent = args[field];
		if (sent === undefined) continue;
		if (!mayChange(grants, field)) {
			blocking.push({
				code: "FIELD_NOT_ALLOWED",
				field,
				message: `${field} can be changed by ${WHO_MAY[GROUP_OF[field]]}, and you are not one of them for this meeting.`,
			});
		}
		const to = normalize(field, sent);
		const from = (meeting[field] ?? null) as Value;
		if (to === from) unchanged.push(field);
		else changes[field] = { from, to };
	}
	return { meetingId, changes, unchanged, blocking };
}

function summarize(plan: EditPlan): string {
	if (plan.blocking.length > 0) {
		return `Blocked: ${plan.blocking.map((b) => b.field).join(", ")} cannot be changed by you. Nothing will be written.`;
	}
	const names = Object.keys(plan.changes);
	if (names.length === 0) {
		return "Nothing to change: the meeting already has these values.";
	}
	return `Will change: ${names.join(", ")}.`;
}

async function probe(
	ctx: Parameters<McpToolDefinition["handler"]>[1],
	meetingId: string,
	capability: DelegateCapability,
) {
	try {
		return await authorizeDelegateForMeeting(ctx, meetingId, capability);
	} catch (err) {
		// Only the role-holder refusal is "this capability is not yours"; the
		// stranger's refusal, a lock or an archived club end the call.
		if (
			err instanceof McpError &&
			err.code === "FORBIDDEN" &&
			err.message === NOT_ROLE_HOLDER_MESSAGE
		) {
			return null;
		}
		throw err;
	}
}

export const editMeetingTool: McpToolDefinition = {
	name: EDIT_MEETING_TOOL,
	audience: "member",
	// A null clears a field; sending the old value back restores it.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
	},
	config: {
		title: "Edit meeting details",
		description:
			"Change one upcoming meeting's details. Send meetingId plus any of " +
			"theme, location, joinUrl, notes, reminders (the announcements), " +
			"wordOfTheDay, wodDefinition, wodExample, tableTopicsNotes, promoNote " +
			"and meetingNumber. An omitted field is kept; null clears it. Who may " +
			"change what: an officer or the meeting's Toastmaster may change theme, " +
			"location, joinUrl, notes and reminders; they and the Grammarian may " +
			"change the word of the day fields; they and the Table Topics Master " +
			"may change tableTopicsNotes; only an officer may change promoNote and " +
			"meetingNumber. A call that sends any field the caller may not change " +
			"writes nothing. Without planHash this writes nothing: it returns each " +
			"changed field before and after, the unchanged ones, any blocking " +
			"fields and a planHash. Show the plan to the user; call again with the " +
			"same input plus that planHash to apply it. Refused for a cancelled or " +
			"completed meeting. The date, time and length are reschedule_meeting's.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		// Authorize FIRST, on the meeting id alone, so a caller with no role on the
		// meeting gets FORBIDDEN and not a VALIDATION message about a field.
		const idParsed = inputSchema.meetingId.safeParse(
			(input as { meetingId?: unknown }).meetingId,
		);
		if (!idParsed.success) {
			throw new McpError("VALIDATION", "meetingId: must be a meeting id.");
		}
		const meetingId = idParsed.data;

		// Which of the three capabilities the caller holds on THIS meeting. One
		// probe each, so a Grammarian is not refused for lacking `agenda` before
		// the plan can say which of the sent fields that affects.
		const agenda = await probe(ctx, meetingId, "agenda");
		const wod = await probe(ctx, meetingId, "wordOfTheDay");
		const topics = await probe(ctx, meetingId, "tableTopicsNotes");
		const first = agenda ?? wod ?? topics;
		if (!first) throw new McpError("FORBIDDEN", NOT_ROLE_HOLDER_MESSAGE);
		const { club, user } = first;
		const grants: Grants = {
			officer: [agenda, wod, topics].some((p) => p?.via === "admin"),
			agenda: agenda !== null,
			wordOfTheDay: wod !== null,
			tableTopicsNotes: topics !== null,
		};
		const actorMemberId = first.actorMemberId ?? club.membershipId;

		const parsed = z.object(inputSchema).safeParse(input);
		if (!parsed.success) {
			throw new McpError(
				"VALIDATION",
				parsed.error.issues
					.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
					.join("; "),
			);
		}
		const args: Args = {};
		for (const field of FIELDS) args[field] = parsed.data[field];
		if (FIELDS.every((f) => args[f] === undefined)) {
			throw new McpError("VALIDATION", NOTHING_TO_CHANGE_MESSAGE);
		}

		const hashOf = (plan: EditPlan) =>
			planHash({
				tool: EDIT_MEETING_TOOL,
				clubId: club.clubId,
				userId: user.id,
				plan,
			});

		if (parsed.data.planHash === undefined) {
			const plan = await buildPlan(db, meetingId, args, grants, false);
			return {
				applied: false,
				meetingId,
				clubId: club.clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
				blocking: plan.blocking,
			};
		}

		const expected = parsed.data.planHash;
		let plan: EditPlan;
		try {
			plan = await db.transaction(async (tx) => {
				const [clubRow] = await tx
					.select({ archivedAt: clubs.archivedAt })
					.from(clubs)
					.where(eq(clubs.id, club.clubId))
					.limit(1)
					.for("share");
				if (!clubRow) throw new McpError("NOT_FOUND", "Club not found.");
				if (isClubArchived(clubRow)) {
					throw new McpError("ARCHIVED", CLUB_ARCHIVED_MESSAGE);
				}
				const fresh = await buildPlan(tx, meetingId, args, grants, true);
				const freshHash = hashOf(fresh);
				if (freshHash !== expected) {
					throw new McpError("PLAN_STALE", STALE_PLAN_MESSAGE, {
						plan: fresh,
						planHash: freshHash,
						summary: summarize(fresh),
					});
				}
				if (fresh.blocking.length > 0) {
					throw new McpError(
						"BLOCKED",
						`Nothing was changed: ${fresh.blocking.map((b) => b.field).join(", ")} cannot be changed by you.`,
						{ blocking: fresh.blocking },
					);
				}
				const changed = Object.keys(fresh.changes) as Field[];
				if (changed.length === 0) return fresh;

				// Send only what moves, from what the caller sent (the writers
				// normalize exactly as the plan did).
				const patchOf = (fields: readonly Field[]) =>
					Object.fromEntries(
						fields.filter((f) => changed.includes(f)).map((f) => [f, args[f]]),
					);
				if (grants.officer || grants.agenda) {
					await applyMeetingMetaPatch(
						{
							meetingId,
							actorMemberId,
							...patchOf(FIELDS),
							// An officer's call; the Toastmaster's refuses meetingNumber
							// and promoNote in the writer as well as above.
							canReschedule: grants.officer,
						},
						tx,
					);
				} else {
					// One patch for whatever narrow grants the caller holds, so a
					// call logs exactly one `meeting_edit`.
					await applyWodAndTableTopicsUpdate(
						{
							meetingId,
							actorMemberId,
							...patchOf([
								...(grants.wordOfTheDay
									? (["wordOfTheDay", "wodDefinition", "wodExample"] as const)
									: []),
								...(grants.tableTopicsNotes
									? (["tableTopicsNotes"] as const)
									: []),
							]),
						},
						tx,
					);
				}
				return fresh;
			});
		} catch (err) {
			if (isUniqueViolation(err)) {
				throw new McpError("VALIDATION", MEETING_NUMBER_TAKEN_MESSAGE);
			}
			throw err;
		}

		return {
			applied: true,
			meetingId,
			clubId: club.clubId,
			summary: summarize(plan),
			plan,
		};
	},
};

/**
 * `set_my_speech_details` — "my speech is called X, Pathways project Y, 5 to 7
 * minutes" through the member's own agent (#1571, child of #1560).
 *
 * `audience: "member"`. OWN SLOT ONLY (maintainer decision, 2026-11-09): the
 * tool writes a speaker slot whose holder is the token owner's own membership.
 * Another member's or a guest's speech is edited in the app. The holder is
 * checked twice: in the plan (so a preview says so) and again by
 * `saveSpeakerDetailsCore` against the LOCKED slot (`onlyHeldBy`), so a release
 * or reassign between preview and apply can never write the new holder's speech.
 *
 * Omitted means unchanged. The app's writer (`editSlotSpeech`) turns every
 * field it is not sent into null, because the edit sheet resubmits all of them,
 * so this tool fills each omitted field from the speech as it stands before
 * calling it. `null` (or an empty string) clears a field.
 *
 * The save itself is `saveSpeakerDetailsCore` in `slots-logic.ts`, shared with
 * the app's `updateSpeakerDetails`: same locks, same asserts, same log row.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { roleDefinitions, roleSlots, speeches } from "#/db/schema";
import { planHash } from "#/lib/mcp-plan";
import { lockClubForWrite } from "#/server/club-write-lock";
import {
	normalizeSpeech,
	SPEAKER_SLOT_NOT_YOURS_MESSAGE,
	type SpeechInput,
	saveSpeakerDetailsCore,
} from "#/server/slots-logic";
import { speakerDetailsUpdateSchema } from "#/server/speaker-details-schema";
import { authorizeTokenForMeeting } from "../authz-logic";
import { McpError } from "../errors";
import {
	type DbOrTx,
	loadLabelledSlots,
	loadMeetingFacts,
	type MemberBlockingItem,
	meetingStateBlocking,
	throwIfLocked,
} from "../member-meeting";
import type { McpToolDefinition } from "../tool";
import { isoInTimezone } from "./get-my-schedule";

const TOOL = "set_my_speech_details";

const text = (what: string) =>
	z
		.string()
		.nullable()
		.optional()
		.describe(`${what} Omit to keep it; null or "" clears it.`);

const inputSchema = {
	meetingId: z.string().uuid().describe("From get_my_schedule."),
	slotId: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Only needed when the caller holds two speaker slots at that meeting; the preview lists them.",
		),
	speechTitle: text("The speech title."),
	introduction: text("The introduction the speaker wants read out."),
	pathwayPath: text("The Pathways path, e.g. Dynamic Leadership."),
	projectName: text("The Pathways project name."),
	projectLevel: text("The Pathways level, e.g. Level 2."),
	projectId: z
		.string()
		.uuid()
		.nullable()
		.optional()
		.describe(
			"A Pathways catalogue project id, only if the caller already has one. null unlinks it.",
		),
	minMinutes: z
		.number()
		.int()
		.nullable()
		.optional()
		.describe("Shortest length in minutes. Send with maxMinutes."),
	maxMinutes: z
		.number()
		.int()
		.nullable()
		.optional()
		.describe("Longest length in minutes. Send with minMinutes."),
	presentationUrl: text("A link to the slides."),
	planHash: z
		.string()
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned, with the same input, to apply it.",
		),
};

const FIELDS = [
	"speechTitle",
	"introduction",
	"pathwayPath",
	"projectName",
	"projectLevel",
	"projectId",
	"minMinutes",
	"maxMinutes",
	"presentationUrl",
] as const;
type Field = (typeof FIELDS)[number];
type Values = Record<Field, string | number | null>;

const FREE_TEXT_PROJECT: Field[] = [
	"pathwayPath",
	"projectName",
	"projectLevel",
];

interface Change {
	field: Field;
	before: string | number | null;
	after: string | number | null;
}

interface Computed {
	plan: {
		meeting: {
			meetingId: string;
			clubName: string;
			startsAt: string;
			status: string;
		};
		slotLabel: string | null;
		changes: Change[];
	};
	planHash: string;
	blocking: MemberBlockingItem[];
	slotId: string | null;
	details: SpeechInput | null;
}

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

/** The speech as stored, in the writer's vocabulary; all null for a TBA slot. */
async function currentValues(
	conn: DbOrTx,
	speechId: string | null,
): Promise<Values> {
	const empty: Values = {
		speechTitle: null,
		introduction: null,
		pathwayPath: null,
		projectName: null,
		projectLevel: null,
		projectId: null,
		minMinutes: null,
		maxMinutes: null,
		presentationUrl: null,
	};
	if (!speechId) return empty;
	const [row] = await conn
		.select({
			speechTitle: speeches.title,
			introduction: speeches.introduction,
			pathwayPath: speeches.pathwayPath,
			projectName: speeches.projectName,
			projectLevel: speeches.projectLevel,
			projectId: speeches.projectId,
			minMinutes: speeches.minMinutes,
			maxMinutes: speeches.maxMinutes,
			presentationUrl: speeches.presentationUrl,
		})
		.from(speeches)
		.where(eq(speeches.id, speechId))
		.limit(1);
	return row ?? empty;
}

async function compute(
	conn: DbOrTx,
	args: Args,
	who: { clubId: string; userId: string; memberId: string },
): Promise<Computed> {
	const facts = await loadMeetingFacts(conn, args.meetingId);
	const labelled = await loadLabelledSlots(conn, args.meetingId);
	const labels = new Map(labelled.map((s) => [s.slotId, s.label]));
	const speakerSlots = await conn
		.select({
			slotId: roleSlots.id,
			holderMemberId: roleSlots.assignedMemberId,
			speechId: roleSlots.speechId,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.where(
			and(
				eq(roleSlots.meetingId, args.meetingId),
				eq(roleDefinitions.isSpeakerRole, true),
			),
		);
	const mine = speakerSlots.filter((s) => s.holderMemberId === who.memberId);

	const blocking = meetingStateBlocking(facts);
	let chosen: (typeof mine)[number] | null = null;
	if (args.slotId) {
		chosen = mine.find((s) => s.slotId === args.slotId) ?? null;
		if (!chosen) {
			blocking.push({
				code: "NOT_YOUR_SLOT",
				message: SPEAKER_SLOT_NOT_YOURS_MESSAGE,
			});
		}
	} else if (mine.length === 0) {
		blocking.push({
			code: "NO_SPEAKER_SLOT",
			message:
				"You don't hold a speaker slot at that meeting. Claim one first (claim_open_role).",
		});
	} else if (mine.length > 1) {
		blocking.push({
			code: "SLOT_REQUIRED",
			message: `You hold more than one speaker slot there; say which with slotId: ${mine
				.map((s) => `${labels.get(s.slotId) ?? "Speaker"} (${s.slotId})`)
				.join(", ")}.`,
		});
	} else {
		chosen = mine[0] ?? null;
	}

	const before = await currentValues(conn, chosen?.speechId ?? null);
	let details: SpeechInput | null = null;
	const changes: Change[] = [];
	if (chosen) {
		const merged: Record<Field, string | number | null> = { ...before };
		for (const f of FIELDS) {
			const sent = args[f];
			if (sent !== undefined) merged[f] = sent;
		}
		// The writer overwrites the free-text triple from a linked catalogue
		// project, so changing one of them while the link stays would be undone.
		// Naming free text without a project is a request to unlink.
		if (
			args.projectId === undefined &&
			before.projectId !== null &&
			FREE_TEXT_PROJECT.some(
				(f) => args[f] !== undefined && args[f] !== before[f],
			)
		) {
			merged.projectId = null;
		}
		const parsed = speakerDetailsUpdateSchema.safeParse({
			speechTitle: merged.speechTitle ?? "",
			introduction: merged.introduction ?? "",
			pathwayPath: merged.pathwayPath ?? "",
			projectName: merged.projectName ?? "",
			projectLevel: merged.projectLevel ?? "",
			projectId: merged.projectId,
			minMinutes: merged.minMinutes ?? undefined,
			maxMinutes: merged.maxMinutes ?? undefined,
			presentationUrl: merged.presentationUrl ?? "",
		});
		if (!parsed.success) {
			throw new McpError(
				"VALIDATION",
				parsed.error.issues
					.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
					.join("; "),
			);
		}
		details = parsed.data;
		const after = normalizeSpeech(parsed.data).content;
		const afterValues: Values = {
			speechTitle: after.title,
			introduction: after.introduction,
			pathwayPath: after.pathwayPath,
			projectName: after.projectName,
			projectLevel: after.projectLevel,
			projectId: after.projectId,
			minMinutes: after.minMinutes,
			maxMinutes: after.maxMinutes,
			presentationUrl: after.presentationUrl,
		};
		for (const f of FIELDS) {
			// A slot with no speech reads as "TBA" on the agenda.
			const was = f === "speechTitle" ? (before[f] ?? "TBA") : before[f];
			if (was !== afterValues[f]) {
				changes.push({ field: f, before: was, after: afterValues[f] });
			}
		}
		if (changes.length === 0) {
			blocking.push({
				code: "NO_CHANGE",
				message: "Those details are already what the speech says.",
			});
		}
	}

	const plan = {
		meeting: {
			meetingId: facts.meetingId,
			clubName: facts.clubName,
			startsAt: isoInTimezone(facts.scheduledAt, facts.timezone),
			status: facts.status,
		},
		slotLabel: chosen ? (labels.get(chosen.slotId) ?? null) : null,
		changes,
	};
	return {
		plan,
		planHash: planHash({
			tool: TOOL,
			clubId: who.clubId,
			userId: who.userId,
			plan: {
				...plan,
				status: "set",
				state: {
					slotId: chosen?.slotId ?? null,
					holderMemberId: chosen?.holderMemberId ?? null,
					speechId: chosen?.speechId ?? null,
					before,
				},
			},
		}),
		blocking,
		slotId: chosen?.slotId ?? null,
		details,
	};
}

export const setMySpeechDetailsTool: McpToolDefinition = {
	name: TOOL,
	audience: "member",
	// Overwrites the speech's stored values, and null/"" clears them. Idempotent:
	// the same input leaves the same speech.
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
	},
	config: {
		title: "Set my speech details",
		description:
			"Set the title, Pathways project, length, introduction or slides link of " +
			"the speech in a speaker slot the CALLER holds. Never another member's or " +
			"a guest's slot; those are edited in the app. Call get_my_schedule first " +
			"to find the meetingId. A field you leave out keeps its current value; " +
			'null or "" clears it. Call once WITHOUT planHash to preview (each ' +
			"changed field, before and after), show it to the user, and only after " +
			"they agree call again with the same input plus the planHash. Naming " +
			"pathwayPath, projectName or projectLevel without a projectId unlinks a " +
			"linked catalogue project, since the link would overwrite them.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeTokenForMeeting(ctx, args.meetingId);
		const who = {
			clubId: club.clubId,
			userId: user.id,
			memberId: club.membershipId,
		};

		if (!args.planHash) {
			const c = await compute(db, args, who);
			return { plan: c.plan, planHash: c.planHash, blocking: c.blocking };
		}
		const hash = args.planHash;

		return db.transaction(async (tx) => {
			await lockClubForWrite(tx, who.clubId);
			const facts = await loadMeetingFacts(tx, args.meetingId);
			throwIfLocked(facts);
			const c = await compute(tx, args, who);
			if (c.planHash !== hash) {
				throw new McpError(
					"PLAN_STALE",
					"That speech changed since you previewed it. Review the fresh plan and ask the user again.",
					{ plan: c.plan, planHash: c.planHash, blocking: c.blocking },
				);
			}
			const first = c.blocking[0];
			if (first || !c.slotId || !c.details) {
				throw new McpError("BLOCKED", first?.message ?? "Nothing to save.", {
					blocking: c.blocking,
				});
			}
			await saveSpeakerDetailsCore(tx, {
				meetingId: args.meetingId,
				slotId: c.slotId,
				details: c.details,
				actorMemberId: who.memberId,
				proof: "connector",
				onlyHeldBy: who.memberId,
			});
			return { saved: c.plan.slotLabel, changes: c.plan.changes };
		});
	},
};

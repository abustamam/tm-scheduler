/**
 * `create_meetings` — make empty meetings on the club's default agenda (#1572).
 *
 * ## Preview, then apply, in the conversation (the `reschedule_meeting` shape)
 *
 * A call WITHOUT `planHash` writes nothing and returns, per date, "would_create"
 * or "skipped" (a meeting already exists on that club-local date, or the date is
 * listed twice), plus any date that does not exist on the club's clock (a DST
 * gap) as `blocking`. The SAME call with that hash re-plans under the club's
 * write lock; a mismatch is `PLAN_STALE` carrying the fresh plan, which is what
 * a date taken between preview and apply becomes.
 *
 * ## The write is `applyBatchCreateMeetings` and nothing else
 *
 * One date is the same call with one entry; there is no second create path. The
 * batch returns counts, not ids, and logs nothing, so this tool reads back the
 * rows it created (by the instants it asked for) and logs one `meeting_create`
 * per row crediting the calling officer, the way `agenda-plan-apply.ts` does.
 * What the app's own create paths log is deliberately untouched.
 */
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings } from "#/db/schema";
import { utcToZonedWallTime, zonedWallTimeToUtc } from "#/lib/datetime";
import { planHash } from "#/lib/mcp-plan";
import { MAX_BATCH } from "#/lib/meeting-recurrence";
import { logActivity } from "#/server/activity";
import { applyBatchCreateMeetings } from "#/server/batch-meetings-logic";
import { lockClubForWrite } from "#/server/club-write-lock";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

export const CREATE_MEETINGS_TOOL = "create_meetings";

export const NO_SUCH_TIME_MESSAGE =
	"That date and time do not exist on the club's clock (the clocks skip it that day). Pick another time.";
export const BLOCKED_MESSAGE =
	"Some dates do not exist on the club's clock. Fix them and preview again.";
const STALE_PLAN_MESSAGE =
	"The club's meetings changed since that preview. Show the user the fresh plan and ask again.";

const WALL_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

const inputSchema = {
	clubId: z.string().uuid(),
	dates: z
		.array(
			z
				.string()
				.regex(
					WALL_RE,
					"Use a club-local date and time, YYYY-MM-DDTHH:mm (24-hour).",
				),
		)
		.min(1)
		.max(MAX_BATCH)
		.describe(
			`1 to ${MAX_BATCH} club-local start times, YYYY-MM-DDTHH:mm, one meeting each.`,
		),
	location: z
		.string()
		.max(300)
		.optional()
		.describe("Optional location for every new meeting."),
	planHash: z
		.string()
		.min(1)
		.max(200)
		.optional()
		.describe(
			"Omit to preview. Pass the planHash a preview returned to apply that plan.",
		),
};

type PlanLine = {
	date: string;
	time: string;
	status: "would_create" | "skipped";
	reason?: string;
};
type BlockedLine = { date: string; time: string; reason: string };
type CreatePlan = {
	timezone: string;
	location: string | null;
	lines: PlanLine[];
	blocking: BlockedLine[];
};

type Conn = Pick<typeof db, "select">;

/** Build the plan from the meetings the club has now. */
async function buildPlan(
	conn: Conn,
	clubId: string,
	timezone: string,
	dates: string[],
	location: string | null,
): Promise<CreatePlan> {
	const existing = await conn
		.select({ scheduledAt: meetings.scheduledAt })
		.from(meetings)
		.where(eq(meetings.clubId, clubId));
	// Any status occupies its calendar date, as `applyBatchCreateMeetings` has it.
	const taken = new Set(
		existing.map((m) =>
			utcToZonedWallTime(m.scheduledAt, timezone).slice(0, 10),
		),
	);
	const seen = new Set<string>();
	const lines: PlanLine[] = [];
	const blocking: BlockedLine[] = [];
	for (const wall of dates) {
		const date = wall.slice(0, 10);
		const time = wall.slice(11, 16);
		if (
			utcToZonedWallTime(zonedWallTimeToUtc(wall, timezone), timezone) !== wall
		) {
			blocking.push({ date, time, reason: NO_SUCH_TIME_MESSAGE });
			continue;
		}
		if (seen.has(date)) {
			lines.push({
				date,
				time,
				status: "skipped",
				reason: "this date is listed more than once",
			});
			continue;
		}
		seen.add(date);
		if (taken.has(date)) {
			lines.push({
				date,
				time,
				status: "skipped",
				reason: "a meeting already exists at that time",
			});
			continue;
		}
		lines.push({ date, time, status: "would_create" });
	}
	return { timezone, location, lines, blocking };
}

function summarize(plan: CreatePlan): string {
	const create = plan.lines.filter((l) => l.status === "would_create").length;
	const skip = plan.lines.length - create;
	const parts = [`Will create ${create} meeting${create === 1 ? "" : "s"}`];
	if (skip > 0) parts.push(`skip ${skip} already taken or repeated`);
	if (plan.blocking.length > 0) {
		parts.push(`${plan.blocking.length} blocked (no such time)`);
	}
	return `${parts.join("; ")}.`;
}

export const createMeetingsTool: McpToolDefinition = {
	name: CREATE_MEETINGS_TOOL,
	audience: "officer",
	// Adds rows only; nothing existing is changed. A repeat with the same dates
	// finds them taken and creates nothing more.
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
	},
	config: {
		title: "Create meetings",
		description:
			"Create empty meetings on the club's default agenda, one per date. " +
			`Send clubId and 1 to ${MAX_BATCH} dates as club-local YYYY-MM-DDTHH:mm, ` +
			"and an optional location. This makes bare meetings with the default " +
			"length and role slots; to set themes or a word of the day use " +
			"upsert_agendas or edit_meeting. Without planHash this writes nothing: " +
			"it returns, per date, would_create or skipped (a meeting already " +
			"exists that day), dates that do not exist on the club's clock as " +
			"blocking, and a planHash. Show the plan to the user; call again with " +
			"the same input plus that planHash to apply it. The result lists each " +
			"new meeting's id and date.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		// Authorize FIRST on the club id alone, so a plain member sending a bad
		// field gets FORBIDDEN and not a VALIDATION message.
		const idParsed = inputSchema.clubId.safeParse(
			(input as { clubId?: unknown }).clubId,
		);
		if (!idParsed.success) {
			throw new McpError("VALIDATION", "clubId: must be a club id.");
		}
		const { club } = await authorizeToken(ctx, idParsed.data);

		const parsed = z.object(inputSchema).safeParse(input);
		if (!parsed.success) {
			throw new McpError(
				"VALIDATION",
				parsed.error.issues
					.map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
					.join("; "),
			);
		}
		const args = parsed.data;
		const location = args.location?.trim() || null;

		const hashOf = (plan: CreatePlan) =>
			planHash({
				tool: CREATE_MEETINGS_TOOL,
				clubId: club.clubId,
				userId: club.membershipId,
				plan,
			});

		if (args.planHash === undefined) {
			const plan = await buildPlan(
				db,
				club.clubId,
				club.timezone,
				args.dates,
				location,
			);
			return {
				applied: false,
				clubId: club.clubId,
				summary: summarize(plan),
				plan,
				planHash: hashOf(plan),
			};
		}

		const expected = args.planHash;
		type Outcome =
			| { stale: CreatePlan }
			| { plan: CreatePlan; created: { meetingId: string; date: string }[] };
		const outcome = await db.transaction(async (tx): Promise<Outcome> => {
			await lockClubForWrite(tx, club.clubId);
			const plan = await buildPlan(
				tx,
				club.clubId,
				club.timezone,
				args.dates,
				location,
			);
			if (hashOf(plan) !== expected) return { stale: plan };
			if (plan.blocking.length > 0) {
				throw new McpError("VALIDATION", BLOCKED_MESSAGE, { plan });
			}
			const wanted = plan.lines.filter((l) => l.status === "would_create");
			if (wanted.length === 0) return { plan, created: [] };

			const walls = wanted.map((l) => `${l.date}T${l.time}`);
			await applyBatchCreateMeetings({
				clubId: club.clubId,
				wallTimes: walls,
				location,
			});
			// The batch returns counts only: read back the rows at the instants it
			// was asked for (the club lock and the plan's own check mean none of
			// them predates this call).
			const instants = walls.map((w) => zonedWallTimeToUtc(w, club.timezone));
			const rows = await tx
				.select({ id: meetings.id, scheduledAt: meetings.scheduledAt })
				.from(meetings)
				.where(
					and(
						eq(meetings.clubId, club.clubId),
						inArray(meetings.scheduledAt, instants),
					),
				);
			const created: { meetingId: string; date: string }[] = [];
			for (const row of rows) {
				const date = utcToZonedWallTime(row.scheduledAt, club.timezone).slice(
					0,
					10,
				);
				created.push({ meetingId: row.id, date });
				await logActivity(tx, {
					clubId: club.clubId,
					actorMemberId: club.membershipId,
					action: "meeting_create",
					targetType: "meeting",
					targetId: row.id,
					detail: { meetingId: row.id, date, via: "mcp-create-meetings" },
				});
			}
			created.sort((a, b) => a.date.localeCompare(b.date));
			return { plan, created };
		});

		if ("stale" in outcome) {
			throw new McpError("PLAN_STALE", STALE_PLAN_MESSAGE, {
				plan: outcome.stale,
				planHash: hashOf(outcome.stale),
				summary: summarize(outcome.stale),
			});
		}
		return {
			applied: true,
			clubId: club.clubId,
			summary: `Created ${outcome.created.length} meeting${outcome.created.length === 1 ? "" : "s"}.`,
			created: outcome.created,
			skipped: outcome.plan.lines.filter((l) => l.status === "skipped"),
		};
	},
};

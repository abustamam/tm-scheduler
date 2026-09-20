/**
 * `upsert_agendas` — set a season's themes in one call (#808, epic #771).
 *
 * Creating a club's year means 52 trips through the meeting form. `list_meetings`
 * and `get_agenda` already let an officer's LLM read the calendar; this is the
 * write that makes reading it useful.
 *
 * It writes NOTHING. It plans every date against live data, stores what was
 * asked as a pending plan, and hands back a LINK. Confirmation happens in
 * GavelUp: the admin who asked opens that link signed in, reads the per-date
 * diff, and clicks Save.
 *
 * ## Why a confirm page here and not for `assign_roles`
 *
 * #806 moved `record_guest_book` behind a page for two reasons — the
 * transcription was unverifiable, and the write mints PII for people who are not
 * users. Neither transfers. What transfers is BLAST RADIUS: one call can create
 * 52 meetings, and a club's calendar is what every other surface reads from.
 *
 * The rule, written down so the next write tool does not re-litigate it: **a
 * page when the write is hard to see or hard to undo.** `assign_roles` (#809) is
 * neither, and applies in-conversation.
 *
 * ## `notes` and `reminders` are deliberately excluded
 *
 * `applyMeetingMetaPatch` owns them and this tool does not offer them.
 * `reminders` feeds the reminder poller, which SENDS EMAIL to members — an LLM
 * proposing changes to what lands in someone's inbox is a different risk class
 * from proposing a theme — and `notes` is internal prose that renders on printed
 * agendas. See `AGENDA_META_FIELDS`.
 *
 * ## The top-up runs ONCE, before planning, outside any transaction
 *
 * A club's recurrence rule materialises future meetings on authenticated reads
 * (ADR-0021), which token calls never reach — so without this an LLM planning
 * three months out would see a calendar the browser does not, and would propose
 * CREATING meetings the club is about to generate for itself. `list-meetings.ts`
 * is the precedent; `ensureScheduleToppedUp` imports `db` directly and takes no
 * connection, so calling it inside a transaction would write on a second
 * connection while a lock is held. `agenda-plan-topup.guard.test.ts` holds both
 * halves, because a second connection under a lock is invisible to a behavioural
 * test.
 */
import { z } from "zod";
import { db } from "#/db";
import { mcpPendingPlans } from "#/db/schema";
import { agendaPlanConfirmUrl } from "#/lib/agenda-upsert";
import { pendingPlanExpiresAt } from "#/lib/pending-plan";
import { appBaseUrl } from "#/lib/unsubscribe-token";
import { agendaPlanHash, agendaPlanSummary, plan } from "#/server/agenda-plan";
import { agendaEntriesSchema } from "#/server/agenda-plan-pending-schemas";
import { ensureScheduleToppedUp } from "#/server/schedule-topup-logic";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const inputSchema = {
	clubId: z.string().uuid(),
	meetings: agendaEntriesSchema.describe(
		"One entry per club-local date. A date with no meeting is CREATED; a " +
			"date with one is UPDATED. Omit a field to leave it alone, send null " +
			"or an empty string to clear it.",
	),
};

export const upsertAgendasTool: McpToolDefinition = {
	name: "upsert_agendas",
	config: {
		title: "Set meeting agendas",
		description:
			"Set the theme, Word of the Day and location on a run of meetings, " +
			"creating any that do not exist yet. This writes NOTHING: it returns a " +
			"plan saying what each date would do, plus a confirmUrl. Give the user " +
			"that link — they open it signed in, read the per-date diff, and save " +
			"it there. It cannot reschedule or delete a meeting, and it never sets " +
			"a meeting number.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx.rawToken, args.clubId);

		// Before planning, before reading, outside any transaction. See the header.
		await ensureScheduleToppedUp(club.clubId);

		// Plan BEFORE the row is written, so a club that cannot be read at all
		// leaves nothing behind. A date that blocks does NOT throw: that is
		// something the confirm page can show and the admin can act on, so it gets
		// a row and a link like any other preview.
		const planClub = { clubId: club.clubId, timezone: club.timezone };
		const {
			plan: p,
			blocking,
			meetingNumbers,
		} = await plan(db, planClub, args.meetings);

		const createdAt = new Date();
		const [row] = await db
			.insert(mcpPendingPlans)
			.values({
				clubId: club.clubId,
				// The discriminator every read of this row filters on (#812). One
				// table serves every MCP write tool, so an id alone does not say
				// what shape its payload has.
				tool: "upsert_agendas",
				// What was ASKED, not what was planned. A pending link is open for
				// up to a day and the page re-plans on every render, so storing
				// "set the theme to Harvest" survives a meeting being rescheduled
				// under it where storing a meeting id would not.
				payload: { meetings: args.meetings },
				createdByUserId: user.id,
				createdAt,
				expiresAt: pendingPlanExpiresAt(createdAt),
			})
			.returning({ id: mcpPendingPlans.id });
		if (!row) throw new McpError("INTERNAL", "Failed to store that plan.");

		return {
			applied: false,
			pendingId: row.id,
			confirmUrl: agendaPlanConfirmUrl(appBaseUrl(), row.id),
			clubId: club.clubId,
			timezone: club.timezone,
			summary: agendaPlanSummary(p),
			// Nothing in a plan line is personal data — a theme and a Word of the
			// Day are club copy — so unlike `record_guest_book` there is no masked
			// projection here. The lines go back as planned.
			plan: p.lines,
			// Provisional meeting numbers, keyed by line index. Alongside the plan
			// and never inside it: numbers freeze when a meeting is completed
			// (#358), so one being frozen elsewhere in the season would otherwise
			// fail every outstanding link as stale.
			meetingNumbers,
			blocking,
			// Informational: the confirm page re-plans and computes its own. It is
			// returned so a caller can tell two previews apart.
			planHash: agendaPlanHash({
				clubId: club.clubId,
				userId: user.id,
				plan: p,
			}),
		};
	},
};

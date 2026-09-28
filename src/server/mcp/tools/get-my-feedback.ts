/**
 * `get_my_feedback` — the caller's OWN anonymous role feedback, "love notes"
 * (#987, part 3 of #981).
 *
 * Read-only, and there is deliberately no write tool beside it: a note written
 * with a credential would carry its writer's identity, which is the one thing a
 * love note may never have (CONTEXT.md, "Love note (role feedback)").
 *
 * WHOSE notes comes from the CREDENTIAL and nothing else. `authenticateToken`
 * resolves the token to its owner, and that user id is the only identity
 * `loadFeedbackForUser` is handed. The input has no member, user or person id,
 * so there is no argument a caller could change to read somebody else's notes.
 * Which notes that user may see — their own memberships' notes, on meetings
 * whose scheduled end has passed — is `recipientMayTouch` inside
 * `loadFeedbackForUser`, THE statement of that rule, shared with the
 * dashboard's read, delete and mark-seen. This tool writes no query of its own.
 *
 * It is authenticate-only rather than club-authorized, like `whoami`: it names
 * no club, and a person's notes span every club they belong to, archived ones
 * included (a takedown stops new notes, not a person reading what they were
 * given). `mcp-authz.guard.test.ts` records that waiver.
 *
 * Dates. `loadFeedbackForUser` takes instants; a token caller speaks in
 * calendar dates, and the notes span clubs in different timezones. So the tool
 * asks the loader for a window padded a day either side (wider than any UTC
 * offset), then keeps the meetings whose CLUB-LOCAL date is inside the
 * requested range — a 7pm Saturday meeting in California is Saturday, not the
 * Sunday it is in UTC. It only ever NARROWS the loader's answer, and it
 * recounts `unseenCount` over what it kept. With no dates it returns the
 * loader's answer verbatim.
 */
import { z } from "zod";
import { clubLocalParts, localDate } from "#/lib/club-local-date";
import {
	type FeedbackForUser,
	loadFeedbackForUser,
} from "#/server/role-feedback-logic";
import { authenticateToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A `YYYY-MM-DD` that is a real calendar date, as UTC midnight. */
const utcMidnight = (date: string): Date | null => {
	const d = new Date(`${date}T00:00:00Z`);
	return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date
		? null
		: d;
};

const calendarDate = localDate.refine((d) => utcMidnight(d) !== null, {
	message: "Not a calendar date.",
});

const inputSchema = {
	meetingId: z
		.string()
		.uuid()
		.optional()
		.describe("Only the notes from this one meeting."),
	from: calendarDate
		.optional()
		.describe("Meetings on or after this club-local date, YYYY-MM-DD."),
	to: calendarDate
		.optional()
		.describe("Meetings on or before this club-local date, YYYY-MM-DD."),
};

/** Keep the meetings whose club-local date is within [from, to], inclusive. */
export function trimToLocalDates(
	res: FeedbackForUser,
	from: string | undefined,
	to: string | undefined,
): FeedbackForUser {
	const meetings = res.meetings.filter((g) => {
		const local = clubLocalParts(new Date(g.meetingDate), g.timezone).date;
		return (!from || local >= from) && (!to || local <= to);
	});
	let unseenCount = 0;
	for (const g of meetings) {
		for (const r of g.roles) {
			for (const n of r.notes) if (!n.seen) unseenCount++;
		}
	}
	return { meetings, unseenCount };
}

export const getMyFeedbackTool: McpToolDefinition = {
	name: "get_my_feedback",
	config: {
		title: "Get my feedback",
		description:
			"Your own anonymous role feedback ('love notes') from meetings that " +
			"have ended, grouped by meeting and role. Read-only; nobody else's " +
			"notes are ever returned, and there is no way to see who wrote a note. " +
			"Optionally narrow to one meeting, or to club-local dates.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		if (args.from && args.to && args.from > args.to) {
			throw new McpError("VALIDATION", "`from` is after `to`.");
		}
		const auth = await authenticateToken(ctx);

		const fromUtc = args.from ? utcMidnight(args.from) : null;
		const toUtc = args.to ? utcMidnight(args.to) : null;
		const res = await loadFeedbackForUser(auth.user.id, {
			meetingId: args.meetingId,
			// Padded wider than any UTC offset; trimmed to club-local dates below.
			from: fromUtc ? new Date(fromUtc.getTime() - DAY_MS) : undefined,
			to: toUtc ? new Date(toUtc.getTime() + 2 * DAY_MS) : undefined,
		});
		if (!args.from && !args.to) return res;
		return trimToLocalDates(res, args.from, args.to);
	},
};

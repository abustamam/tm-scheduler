import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "#/db";
import { meetings, roleDefinitions, roleSlots } from "#/db/schema";
import { speechLogEvaluatorNames } from "#/lib/speech-log";
import { loadClubMembers, loadMemberProfile } from "./club-logic";
import { requireClubViewAccess, requireUser } from "./guards";
import { loadMySpeechLog, loadSpeechLog } from "./my-activity-logic";
import {
	currentOfficersByMember,
	currentOfficersFor,
} from "./officer-terms-logic";
import {
	listOpenSpeakerSlots,
	listUnscheduledSpeeches,
} from "./speeches-logic";

const uuid = z.string().uuid();

/** How many speeches a speech log shows before "Show all" (#681). */
const SPEECH_LOG_DEFAULT_LIMIT = 6;

/**
 * A club's roster members (from the `members` table — the no-auth roster) with
 * a "speeches given" count keyed directly to the member row.
 *
 * Pathways progress (path / level / % / project) and member status have NO
 * model — those stay mocked in the view (see docs/persistence-todo.md).
 */
export const listClubMembers = createServerFn({ method: "GET" })
	.validator((clubId: unknown) => uuid.parse(clubId))
	.handler(async ({ data: clubId }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, clubId);

		// Roster rows incl. contact, with phone coalesced to E.164 (#295) so the
		// rendered WhatsApp link is a valid full number. Query lives in
		// `club-logic.ts` so it is directly testable and stays out of the client
		// bundle — see that module's header.
		const roster = await loadClubMembers(clubId);

		// Current office(s) per member, derived from open officer terms (#100).
		const officers = await currentOfficersByMember(roster.map((m) => m.id));

		const speechRows = await db
			.select({
				memberId: roleSlots.assignedMemberId,
				speeches: sql<number>`count(*)::int`,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
			.where(
				and(
					eq(meetings.clubId, clubId),
					eq(roleDefinitions.isSpeakerRole, true),
				),
			)
			.groupBy(roleSlots.assignedMemberId);

		const speechByMember = new Map(
			speechRows
				.filter((r) => r.memberId)
				.map((r) => [r.memberId as string, r.speeches]),
		);

		return roster.map((m) => ({
			id: m.id,
			name: m.name,
			email: m.email,
			// Contact, same PII class and same gate as `email` above (#266): the
			// club's own signed-in members, never a public caller.
			phone: m.phone,
			officerPositions: officers.get(m.id) ?? [],
			userId: m.userId,
			invitedAt: m.invitedAt,
			status: m.status,
			createdAt: m.createdAt,
			joinedAt: m.joinedAt,
			originalJoinDate: m.originalJoinDate,
			speeches: speechByMember.get(m.id) ?? 0,
		}));
	});

/** Roles a member has served (any role), grouped by role name, for the current calendar year. */
async function loadRolesServed(memberId: string, clubId: string) {
	const yearStart = new Date(new Date().getFullYear(), 0, 1);
	return db
		.select({
			name: roleDefinitions.name,
			count: sql<number>`count(*)::int`,
		})
		.from(roleSlots)
		.innerJoin(
			roleDefinitions,
			eq(roleDefinitions.id, roleSlots.roleDefinitionId),
		)
		.innerJoin(meetings, eq(meetings.id, roleSlots.meetingId))
		.where(
			and(
				eq(roleSlots.assignedMemberId, memberId),
				eq(meetings.clubId, clubId),
				gte(meetings.scheduledAt, yearStart),
			),
		)
		.groupBy(roleDefinitions.name)
		.orderBy(desc(sql`count(*)`));
}

/** A roster member's profile: real identity + speech log + roles served. Pathways/awards stay mocked. */
export const getMemberProfile = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z
			.object({
				clubId: uuid,
				memberId: uuid,
				// #681: the profile's speech log shows the newest 6 unless the page
				// asks for all of them (`?speeches=all`).
				allSpeeches: z.boolean().optional(),
			})
			.parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		await requireClubViewAccess(currentUser.id, data.clubId);

		// Identity + contact for this club's member, with phone coalesced to E.164
		// (#295) so the profile's WhatsApp link is a valid full number. Query lives
		// in `club-logic.ts` — see that module's header.
		const member = await loadMemberProfile(data.clubId, data.memberId);

		if (!member) {
			return {
				member: null,
				speechLog: [],
				speechLogTruncated: false,
				rolesServed: [],
				speeches: 0,
				unscheduledSpeeches: [],
				openSpeakerSlots: [],
			};
		}

		// Current office(s) derived from open officer terms (#100).
		const officerPositions = await currentOfficersFor(member.id);

		// History keys directly to the member row — no user bridge needed.
		const { rows: speechLog, truncated: speechLogTruncated } =
			await loadSpeechLog(
				[member.id],
				data.clubId,
				data.allSpeeches ? null : SPEECH_LOG_DEFAULT_LIMIT,
			);
		const rolesServed = await loadRolesServed(member.id, data.clubId);
		// The Person's unscheduled speeches (derived from slot linkage, ADR-0009 /
		// #102) + the club's open speaker slots to reschedule them into. Archived
		// drafts are included so the profile can offer unarchive; the view splits
		// live vs. archived on the row's `archived` flag.
		const unscheduledSpeeches = await listUnscheduledSpeeches(db, {
			personId: member.personId,
			includeArchived: true,
		});
		const openSpeakerSlots = await listOpenSpeakerSlots(db, data.clubId);

		return {
			member: {
				id: member.id,
				name: member.name,
				preferredName: member.preferredName,
				email: member.email,
				phone: member.phone,
				// Both spellings travel: `phone` is coalesced for the WhatsApp link,
				// `phoneRaw` is the column verbatim for the edit dialog's prefill.
				// Binding the dialog to `phone` writes the country-code guess back over
				// the stored digits on save — see `loadMemberProfile`.
				phoneRaw: member.phoneRaw,
				officerPositions,
				userId: member.userId,
				status: member.status,
				clubRole: member.clubRole,
				createdAt: member.createdAt,
				joinedAt: member.joinedAt,
				originalJoinDate: member.originalJoinDate,
			},
			speechLog,
			speechLogTruncated,
			rolesServed,
			speeches: speechLog.length,
			unscheduledSpeeches,
			openSpeakerSlots,
		};
	});

/**
 * The current user's speech history (across their clubs). Backs the dashboard
 * speech log: the newest 6 by default, every speech with `allSpeeches` (#681).
 *
 * TWO RESPONSE SHAPES, keyed on whether an input was sent, and that is the
 * stale-tab contract rather than an accident. Before #681 this fn took no input
 * and returned a bare `SpeechLogRow[]` whose rows carried `evaluatorName`, and
 * the dashboard loader `.map`s it. A tab loaded before the deploy keeps calling
 * it with no input, so it still gets that bare array of the newest 6, each row
 * still carrying `evaluatorName`. An object there would throw in the old render
 * (`speeches.map is not a function`) and blank the dashboard. The current
 * dashboard always sends an input, and gets the rows plus `speechLogTruncated`
 * for its "Show all" link. `list-my-speeches-stale-tab.guard.test.ts` pins both
 * halves. The method stays GET for the same reason (CLAUDE.md: a server fn's
 * method is part of its wire contract).
 */
export const listMySpeeches = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z.object({ allSpeeches: z.boolean().optional() }).optional().parse(input),
	)
	.handler(async ({ data }) => {
		const currentUser = await requireUser();
		const { rows, truncated } = await loadMySpeechLog(
			currentUser.id,
			data?.allSpeeches ? null : SPEECH_LOG_DEFAULT_LIMIT,
		);
		// Legacy shape for a pre-#681 tab: a bare array, and each row still
		// carries `evaluatorName` (the field that render reads) so the stale
		// dashboard keeps showing the evaluator rather than silently dropping it.
		if (data === undefined) {
			return rows.map((r) => ({
				...r,
				evaluatorName: speechLogEvaluatorNames(r.evaluators),
			}));
		}
		return { speeches: rows, speechLogTruncated: truncated };
	});

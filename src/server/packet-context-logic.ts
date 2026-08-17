/**
 * What a meeting says about itself, for the packet picker's derived defaults
 * (#589).
 *
 * SEPARATE FROM `packet-pdf-logic.ts`, and the split is load-bearing twice
 * over. That module imports `@react-pdf/renderer`; this one is reached from a
 * server fn a client route imports, so keeping them together pointed the
 * dialog's import graph at a PDF renderer as well as at `#/db` — a heavier
 * version of the `pg` → `Buffer` leak CLAUDE.md documents. And it is the seam
 * that makes this query reachable from vitest at all: a `createServerFn`
 * handler cannot be invoked from a test.
 *
 * The RULE this feeds (`defaultPacketSelection`) is pure and lives in
 * `#/lib/meeting-packet`, tested without a database. This is only the read.
 */
import { eq } from "drizzle-orm";
import { db } from "#/db";
import {
	meetings,
	meetingVoteSessions,
	roleDefinitions,
	roleSlots,
} from "#/db/schema";
import type { PacketContext } from "#/lib/meeting-packet";
import { isReadableClubForMeeting } from "#/server/club-readable-logic";

/** The shape an archived or unknown meeting answers with: a packet with
 *  nothing in it, which the picker renders as every box unticked. */
const EMPTY: PacketContext = {
	roles: [],
	usesDigitalVoting: false,
	hasWord: false,
};

export async function loadPacketContext(
	meetingId: string,
): Promise<PacketContext> {
	// PUBLIC and session-less (#544): archiving is the platform takedown lever,
	// so a taken-down club's meeting must be indistinguishable from one that
	// never existed. Returning the empty context rather than throwing means no
	// caller needs new error handling — the dialog simply offers nothing, which
	// is also what it shows for a meeting with no roles and no word.
	if (!(await isReadableClubForMeeting(meetingId))) return EMPTY;

	const [roleRows, voteRows, [meetingRow]] = await Promise.all([
		db
			.selectDistinct({
				key: roleDefinitions.key,
				// The NAME travels too: a role definition with a null key still
				// identifies itself, and dropping it here is how a club whose roles
				// predate the #368 key backfill would get an empty packet.
				name: roleDefinitions.name,
			})
			.from(roleSlots)
			.innerJoin(
				roleDefinitions,
				eq(roleDefinitions.id, roleSlots.roleDefinitionId),
			)
			.where(eq(roleSlots.meetingId, meetingId)),
		// A session EXISTS, open or closed: a club that voted on phones last
		// segment is a club that votes on phones, and the paper tally it replaces
		// should not come back the moment the vote is closed.
		db
			.select({ id: meetingVoteSessions.id })
			.from(meetingVoteSessions)
			.where(eq(meetingVoteSessions.meetingId, meetingId))
			.limit(1),
		db
			.select({ word: meetings.wordOfTheDay })
			.from(meetings)
			.where(eq(meetings.id, meetingId))
			.limit(1),
	]);
	return {
		roles: roleRows.map((r) => ({ key: r.key, name: r.name })),
		usesDigitalVoting: voteRows.length > 0,
		hasWord: Boolean(meetingRow?.word?.trim()),
	};
}

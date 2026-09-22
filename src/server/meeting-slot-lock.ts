import { eq } from "drizzle-orm";
import type { db } from "#/db";
import { meetings } from "#/db/schema";

type Transaction = Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/** Serialize slot membership, numbering and pairing decisions on the meeting.
 * Take this before slot/template locks and read status/shape from the returned
 * row. Multi-meeting callers must acquire meeting locks in ascending id order.
 * Claim writers lock slots separately; a meeting lock alone does not exclude them.
 */
export async function lockMeetingForSlotEdit(
	tx: Transaction,
	meetingId: string,
) {
	const [locked] = await tx
		.select({
			id: meetings.id,
			clubId: meetings.clubId,
			status: meetings.status,
			templateId: meetings.templateId,
			scheduledAt: meetings.scheduledAt,
		})
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.for("update")
		.limit(1);
	if (!locked) throw new Error("Meeting not found.");
	return locked;
}

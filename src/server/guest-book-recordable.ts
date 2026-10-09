/**
 * The meeting-status half of "may this guest-book page be recorded" (#1137).
 *
 * Recording a page writes a guest (maybe) and an attendance row against one
 * meeting, so it is the `record` write class: a meeting the class refuses takes
 * no page. Today that is a cancelled meeting, which never happened. A completed
 * one is accepted, because writing a meeting up is what happens after it.
 *
 * `plan()` (`guest-book-plan.ts`) resolves the meeting from a DATE and, by
 * design, does not look at its status: a cancelled meeting still occupies its
 * date, so the date names it, and the planner's header is that meeting. The
 * refusal therefore lives in the three places that go on to use the plan, each
 * calling THIS once `plan()` has named the meeting:
 *
 *   - `applyGuestBookPlan`: the write, inside the club lock, before the hash is
 *     compared, so a cancelled meeting reads as cancelled whatever else moved;
 *   - `renderPendingPlan`: the confirm page, which turns the refusal into its
 *     `unplannable` state like any other `McpError` out of the planner;
 *   - the `record_guest_book` tool: before the pending row is written, so a page
 *     that cannot be recorded leaves nothing behind and the caller is told why.
 *
 * One sentence in all three: the policy's own `MEETING_CANCELLED_MESSAGE`.
 *
 * The read takes `FOR SHARE` on the meeting row, in all three. Every status
 * writer takes the row `FOR NO KEY UPDATE` (`lockMeetingForSlotEdit`, which
 * cancel, complete, reopen and restore all share), and the two conflict, so a
 * cancel still in flight is WAITED for and then seen, and once the SHARE is
 * held a cancel waits for this transaction. In the apply that closes the window
 * between the check and the inserts; in the other two it only makes the read
 * agree with a cancel that is about to commit. The order is the one the capture
 * already uses: club lock, then club row, then this meeting row.
 */
import { eq } from "drizzle-orm";
import { meetings } from "#/db/schema";
import {
	assertMeetingAccepts,
	type MeetingWriteClass,
	meetingRefusal,
} from "#/lib/meeting-lifecycle";
import type { Conn } from "#/server/guest-book-plan";
import { McpError } from "#/server/mcp/errors";

/** What recording a guest-book page is. One constant for both calls below, so
 *  the pre-check and the sentence cannot be asked about different classes. */
const PAGE_WRITE_CLASS: MeetingWriteClass = "record";

/**
 * The sentence for "the date this page names no longer names one meeting": the
 * meeting was rescheduled, deleted, or joined by a second one on the day. One
 * constant because the planner's apply and this gate say the same fact, and a
 * test can then tell a refusal from its neighbour by identity.
 */
export const DATE_NAMES_NO_MEETING_MESSAGE =
	"That date no longer names one meeting.";

/**
 * Refuse a meeting the `record` class refuses, as `McpError("LOCKED", …)`: the
 * code `errors.ts` reserves for "this meeting no longer accepts the request,
 * completed or cancelled", with the policy's sentence on it so the caller reads
 * the state and never infers it from the code.
 *
 * Only a REFUSAL becomes `LOCKED`. A status the policy has never heard of makes
 * `meetingRefusal` throw, and that plain error is left to propagate: "this
 * meeting is locked" would be a lie about a meeting nobody can say anything
 * true about.
 *
 * A meeting that is gone is `BLOCKED` with `DATE_NAMES_NO_MEETING_MESSAGE`,
 * rather than being left to the foreign key's driver error.
 */
export async function assertGuestBookMeetingRecordable(
	conn: Conn,
	meetingId: string,
): Promise<void> {
	const [row] = await conn
		.select({ status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1)
		.for("share");
	if (!row) {
		throw new McpError("BLOCKED", DATE_NAMES_NO_MEETING_MESSAGE);
	}
	if (meetingRefusal(row.status, PAGE_WRITE_CLASS) === null) return;
	try {
		assertMeetingAccepts(row.status, PAGE_WRITE_CLASS);
	} catch (err) {
		throw new McpError(
			"LOCKED",
			err instanceof Error ? err.message : String(err),
		);
	}
}

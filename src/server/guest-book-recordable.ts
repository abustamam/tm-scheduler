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
 * A READ, not a row lock, in every one of them. The apply's window is the
 * statements between this read and its inserts, the one #1057 accepted for
 * planned attendance; the other two only describe what an apply would do, and
 * apply asks again.
 */
import { eq } from "drizzle-orm";
import { meetings } from "#/db/schema";
import { assertMeetingAccepts } from "#/lib/meeting-lifecycle";
import type { Conn } from "#/server/guest-book-plan";
import { McpError } from "#/server/mcp/errors";

/**
 * Refuse a meeting the `record` class refuses, as `McpError("LOCKED", …)`: the
 * code `errors.ts` reserves for "this meeting no longer accepts the request,
 * completed or cancelled", with the policy's sentence on it so the caller reads
 * the state and never infers it from the code.
 *
 * A meeting that is gone is `BLOCKED` with the sentence the apply already uses
 * for "that date no longer names one meeting", rather than being left to the
 * foreign key's driver error.
 */
export async function assertGuestBookMeetingRecordable(
	conn: Conn,
	meetingId: string,
): Promise<void> {
	const [row] = await conn
		.select({ status: meetings.status })
		.from(meetings)
		.where(eq(meetings.id, meetingId))
		.limit(1);
	if (!row) {
		throw new McpError("BLOCKED", "That date no longer names one meeting.");
	}
	try {
		assertMeetingAccepts(row.status, "record");
	} catch (err) {
		throw new McpError(
			"LOCKED",
			err instanceof Error ? err.message : String(err),
		);
	}
}

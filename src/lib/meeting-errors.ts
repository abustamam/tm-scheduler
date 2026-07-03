/** True when an error from `getMeeting` means the meeting row was absent
 *  (as opposed to some other server/DB failure, which should stay fatal). */
export function isMeetingNotFoundError(err: unknown): boolean {
	return err instanceof Error && err.message === "Meeting not found.";
}

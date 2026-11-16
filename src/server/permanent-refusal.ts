/**
 * A refusal the server will give every time for the same queued role write
 * (#1638): the member has ended, the meeting is completed or cancelled, the
 * club is archived. The expected-holder path answers it as `refused` and the
 * client drops the op; ANY other failure (a driver error, a deadlock, a
 * connection reset, a sign-in refusal) must keep throwing so the op stays
 * queued.
 *
 * The shared gates (`lockMemberForAssignment`, `assertClubNotArchived`,
 * `assertMeetingAccepts`, `requireMemberInClub`) throw plain `Error`s and are
 * not changed. `toPermanentRefusal` translates only their known messages, at
 * the expected-holder call sites, so a plain `Error` with any other message is
 * never mistaken for one.
 */
export class PermanentRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PermanentRefusal";
	}
}

/** Rethrow `error` as a `PermanentRefusal` when it is a plain `Error` whose
 *  message is one of `messages`; otherwise rethrow it untouched. */
export function toPermanentRefusal(
	error: unknown,
	messages: ReadonlySet<string>,
): never {
	if (
		error instanceof Error &&
		error.constructor === Error &&
		messages.has(error.message)
	) {
		throw new PermanentRefusal(error.message);
	}
	throw error;
}

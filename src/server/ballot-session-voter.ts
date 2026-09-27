import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { loadBallotSessionVoter } from "./ballot-session-voter-logic";
import { requireUser } from "./guards";

/**
 * The signed-in member this phone votes as on a meeting's ballot (#962), or
 * null. Requires a session (a signed-out caller is refused, and the page then
 * behaves as signed out), and answers only with the caller's OWN member id and
 * roster name in the meeting's club, never anyone else's. Read-only, so a GET.
 *
 * Called by the ballot page only once `useSession()` reports a user, and never
 * from its loader, which about twenty phones load at once.
 */
export const getBallotSessionVoter = createServerFn({ method: "GET" })
	.validator((input: unknown) =>
		z.object({ meetingId: z.string().uuid() }).parse(input),
	)
	.handler(async ({ data }) => {
		const user = await requireUser();
		return loadBallotSessionVoter(data.meetingId, user.id);
	});

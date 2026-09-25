/**
 * Resolve a `$meetingId` URL segment to the meeting's uuid for a SIGNED-IN
 * caller (#877).
 *
 * The agenda editor's server fns (`getAgendaDraft` and its writes) take a bare
 * uuid, while every link into `/club/<club>/meeting/<key>/…` may carry a
 * club-local date key. Resolving here, before the draft is fetched, is what lets
 * `/meeting/2026-09-26/agenda` open the editor instead of failing `uuid.parse`
 * with a 500.
 *
 * Session-bearing ON PURPOSE (`requireUser`). The only caller is the agenda
 * route, which already sends a session-less visitor to /signin in its
 * `beforeLoad`, so an anonymous reader here would be a new public endpoint with
 * no page behind it — and the archive-gate sweep
 * (`public-readers-archive-gate.guard.test.ts`) would rightly demand it be
 * enrolled. Resolution itself goes through `resolvePublicMeetingKey`, so an
 * archived club answers not-found here exactly as it does on the meeting page.
 *
 * Throws "Meeting not found." when nothing matches — the message
 * `isMeetingNotFoundError` recognises, so the route turns it into `notFound()`.
 *
 * The archive half is pinned by `meeting-key.guard.test.ts`: the route test
 * mocks this module wholesale, and the archive sweep skips a fn that calls
 * `requireUser`, so nothing else would notice `resolveMeetingKey` swapped in.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireUser } from "./guards";
import { resolvePublicMeetingKey } from "./meeting-resolve-logic";

const meetingKeyInput = z.object({
	clubId: z.string().uuid(),
	key: z.string().min(1),
});

export const resolveMeetingKeyForUser = createServerFn({ method: "GET" })
	.validator((input: unknown) => meetingKeyInput.parse(input))
	.handler(async ({ data }): Promise<{ meetingId: string }> => {
		await requireUser();
		const meetingId = await resolvePublicMeetingKey(data.clubId, data.key);
		if (!meetingId) throw new Error("Meeting not found.");
		return { meetingId };
	});

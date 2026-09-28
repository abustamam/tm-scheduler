import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { FEEDBACK_TEXT_MAX } from "#/lib/feedback-window";
import {
	type FeedbackTargetsPublic,
	leaveFeedbackLogic,
	loadFeedbackTargetsPublic,
} from "./role-feedback-logic";

// The db-touching logic lives in `role-feedback-logic.ts`; this module exports
// ONLY createServerFns + types (see `server-modules.guard.test.ts`).
export type {
	FeedbackTarget,
	FeedbackTargetKind,
	FeedbackTargetsPublic,
} from "./role-feedback-logic";

const targetsInput = z.object({
	clubId: z.string().uuid(),
	// No max: the key comes off the URL, and an over-long or garbage key must
	// answer null (not-found) from `parseMeetingKey`, not a validation 500.
	meetingKey: z.string().min(1),
});

/**
 * The public feedback page's data (#984): the meeting, its window, and the
 * members a note may be left for. No session. Archive-gated inside
 * `loadFeedbackTargetsPublic` (via `resolvePublicMeetingKey`), which returns
 * null for an archived club, an unknown key or a cancelled meeting.
 */
export const getFeedbackTargetsPublic = createServerFn({ method: "GET" })
	.validator((input: unknown) => targetsInput.parse(input))
	.handler(
		async ({ data }): Promise<FeedbackTargetsPublic | null> =>
			loadFeedbackTargetsPublic(data.clubId, data.meetingKey),
	);

// A little slack over the trimmed cap, so a note with surrounding whitespace is
// judged by the logic's own trimmed rule rather than refused here.
// A NUL is refused here AND in the logic (`cleanText`): Postgres rejects it in
// `text` (22021), and the driver's error would otherwise name the insert.
const textField = z
	.string()
	.max(FEEDBACK_TEXT_MAX * 2)
	.refine((v) => !v.includes("\u0000"), "Invalid character.")
	.nullish();

const leaveInput = z.object({
	meetingId: z.string().uuid(),
	target: z.object({
		kind: z.enum(["slot", "tableTopics"]),
		id: z.string().uuid(),
	}),
	wentWell: textField,
	tryNext: textField,
});

/**
 * Leave an anonymous note (#984). No session, and deliberately no identity of
 * any kind: the input has no field for one and the result carries nothing but
 * `ok`. Every gate — the archive (under the club lock), the window on the
 * server's clock, the target, the two caps — is in `leaveFeedbackLogic`.
 */
export const leaveFeedback = createServerFn({ method: "POST" })
	.validator((input: unknown) => leaveInput.parse(input))
	.handler(
		async ({ data }): Promise<{ ok: true }> =>
			// `x-real-ip` is what Railway's edge sets; `x-forwarded-for` is
			// client-settable, so it would let a caller pick its own bucket (the
			// same reasoning, and the same header, as Better Auth's limiter in
			// `src/lib/auth.ts`, #847). Used for the in-memory limiter only.
			leaveFeedbackLogic(
				data,
				undefined,
				getRequest().headers.get("x-real-ip"),
			),
	);

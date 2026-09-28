/**
 * The wire shape of `leaveFeedback` (#984, #1021), held here rather than in
 * `src/server/role-feedback.ts` because that module may export only server fns
 * and types (`server-modules.guard.test.ts`), and the schema needs a unit test.
 *
 * TWO shapes, both accepted, so a tab opened before a deploy keeps working:
 *
 *  - LEGACY `{ meetingId, target: { kind, id } }`: the page before #1021. The
 *    recipient is whoever holds that slot or Table Topics row, as before.
 *  - PERSON `{ meetingId, recipientMemberId, role }`: a note for a member, with
 *    the role the writer picked. The server still decides whether that member
 *    may receive it and derives the label from `role.kind`; the label is never
 *    free text.
 *
 * A MIX of the two is refused, rather than parsed as whichever branch matches
 * first and silently dropping the other half's fields. Neither shape has any
 * field for the writer: see the anonymity rule in `role-feedback-logic.ts`.
 */
import { z } from "zod";
import { FEEDBACK_TEXT_MAX } from "#/lib/feedback-window";

/** The role label every Table Topics speaker's note carries. Shared by the
 *  server, which stores it, and the page's picker, which shows it. */
export const TABLE_TOPICS_SPEAKER_LABEL = "Table Topics speaker";
/** The label of a note left for a person with no particular role (#1021). */
export const GENERAL_FEEDBACK_LABEL = "General";

// A little slack over the trimmed cap, so a note with surrounding whitespace is
// judged by the logic's own trimmed rule rather than refused here.
// A NUL is refused here AND in the logic (`cleanText`): Postgres rejects it in
// `text` (22021), and the driver's error would otherwise name the insert.
const textField = z
	.string()
	.max(FEEDBACK_TEXT_MAX * 2)
	.refine((v) => !v.includes("\u0000"), "Invalid character.")
	.nullish();

/** Present-and-defined is refused; absent is fine. Keeps the shapes apart. */
const absent = z.never().optional();

const legacyLeaveInput = z.object({
	meetingId: z.string().uuid(),
	target: z.object({
		kind: z.enum(["slot", "tableTopics"]),
		id: z.string().uuid(),
	}),
	wentWell: textField,
	tryNext: textField,
	recipientMemberId: absent,
	role: absent,
});

const feedbackRoleChoiceInput = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("slot"), slotId: z.string().uuid() }),
	z.object({ kind: z.literal("tableTopics"), speakerId: z.string().uuid() }),
	z.object({
		kind: z.literal("definition"),
		roleDefinitionId: z.string().uuid(),
	}),
	z.object({ kind: z.literal("tableTopicsSpeaker") }),
	z.object({ kind: z.literal("general") }),
]);

const personLeaveInput = z.object({
	meetingId: z.string().uuid(),
	recipientMemberId: z.string().uuid(),
	role: feedbackRoleChoiceInput,
	wentWell: textField,
	tryNext: textField,
	target: absent,
});

export const leaveFeedbackInput = z.union([legacyLeaveInput, personLeaveInput]);

// The input TYPES are these schemas' own, so the wire and the logic cannot
// drift: a kind added to the schema is a kind `resolvePersonNote` must handle.

/** The role a writer picked for a named recipient (#1021). The label stored
 *  is derived from the kind on the server, never sent as text:
 *  - `slot` / `tableTopics`: a row this recipient holds at this meeting;
 *  - `definition`: any enabled role of the club, unnumbered;
 *  - `tableTopicsSpeaker`: "Table Topics speaker", not on the minutes' list;
 *  - `general`: "General". */
export type FeedbackRoleChoice = z.infer<typeof feedbackRoleChoiceInput>;
/** The page before #1021: a slot or Table Topics row, whose holder receives
 *  the note. Still accepted, unchanged, for a tab opened before a deploy. */
export type LegacyLeaveFeedbackInput = z.infer<typeof legacyLeaveInput>;
/** A note for a named member, under the role the writer picked (#1021). */
export type PersonLeaveFeedbackInput = z.infer<typeof personLeaveInput>;

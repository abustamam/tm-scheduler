/**
 * `record_guest_book` — transcribe a page of the paper guest book (#773, D7),
 * PREVIEW-ONLY since #806.
 *
 * An LLM reads a photo of the page and calls this with what it read. The tool
 * plans against live data, stores the transcription as a pending plan, and
 * hands back a LINK. It writes no guest and no attendance row. Confirmation
 * happens in GavelUp: the maintainer opens that link signed in, sees the real
 * values, fixes what the transcription got wrong, and clicks Apply.
 *
 * ## Why confirmation moved out of the conversation
 *
 * The preview→apply loop this tool shipped with lived entirely inside the LLM
 * conversation: the plan came back masked, and the MODEL held the `planHash`
 * that applied it. Two consequences, and both are structural rather than
 * cosmetic. The maintainer could not verify the field most likely to be misread
 * from handwriting, because it was masked on the way out. And "show the plan
 * and get an explicit yes" was a sentence in this description — a prompt
 * convention — rather than something the system enforced. A misread address was
 * written silently and surfaced weeks later as minutes that never arrived.
 *
 * What this does NOT do is keep a visitor's contact details out of the LLM
 * transcript. They arrive here as tool-call arguments in plaintext, so the
 * model has already seen every address on the way in; masking the RESPONSE
 * protects nothing that was not exposed a message earlier. It still happens,
 * because the response is where a value the caller never sent would otherwise
 * appear — the ambiguity candidates are guests already on file, and those the
 * model has not seen. The goal of this change is human verification, correction
 * and a structural write gate, not isolation of personal data; server-side
 * transcription would be the only thing that achieved the latter, and it is a
 * different, larger feature.
 *
 * ## What is still true from #773
 *
 * **One meeting per call.** The paper book records no dates; the maintainer
 * says which meeting a page belongs to, and the plan header names the meeting
 * back (number, club-local date, theme) so a wrong date is visible before
 * anything is written rather than after it reaches the minutes email.
 *
 * **A call applies entirely or not at all.** Problems with individual entries
 * are `blocking` items, and apply refuses while any remain — a half-transcribed
 * page is worse than a refused one, because the half that landed is invisible
 * next to the half that did not.
 *
 * **The plan is built in FULL and masked on the way out** (D9). `plan()` and
 * both projections now live in `src/server/guest-book-plan.ts`, shared with the
 * confirm page; see that module for why the masking is two functions and not
 * one.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "#/db";
import { mcpPendingPlans } from "#/db/schema";
import { localDate } from "#/lib/club-local-date";
import {
	guestBookConfirmUrl,
	type PendingEntry,
	pendingPlanExpiresAt,
} from "#/lib/guest-book-pending";
import { MAX_GUEST_BOOK_ENTRIES } from "#/lib/mcp-limits";
import { appBaseUrl } from "#/lib/unsubscribe-token";
import { loadClubDefaultCountryCode } from "#/server/clubs-logic";
import {
	guestBookPlanHash,
	plan,
	toPublicBlocking,
	toPublicPlan,
} from "#/server/guest-book-plan";
import { authorizeToken } from "../authz-logic";
import { McpError } from "../errors";
import type { McpToolDefinition } from "../tool";

const entrySchema = z.object({
	name: z.string().trim().min(1).max(200),
	preferredName: z.string().trim().max(200).optional(),
	email: z.string().trim().max(320).optional(),
	phone: z.string().trim().max(50).optional(),
});

const inputSchema = {
	clubId: z.string().uuid(),
	meetingDate: localDate.describe("The club-local date of the meeting."),
	entries: z.array(entrySchema).min(1).max(MAX_GUEST_BOOK_ENTRIES),
	resolve: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			'Answers to ambiguous entries: {"<entryIndex>": "<guestId>" | "new"}. ' +
				"Prefer leaving these to the person confirming the page.",
		),
	planHash: z
		.string()
		.optional()
		.describe(
			"No longer accepted. Applying happens on the confirm page this tool returns a link to.",
		),
};

type Entry = z.infer<typeof entrySchema>;

/**
 * The refusal a caller written against the old two-call contract gets.
 *
 * A clean structured refusal rather than a 500, for the same reason CLAUDE.md
 * gives for a `createServerFn` method flip: a client loaded before the change
 * is still out there, and the failure it meets should say what to do instead.
 */
export const PLAN_HASH_RETIRED_MESSAGE =
	"record_guest_book no longer applies a plan. It returns a confirmUrl — " +
	"give that link to the person recording the page, and they apply it in " +
	"GavelUp after checking the values.";

/**
 * Carry the transcription into the stored shape, minting the STABLE id each
 * line keeps for the life of the pending row.
 *
 * The id is what lets the confirm page drop a line safely: `plan()` numbers
 * entries positionally, so dropping one renumbers every line after it, and
 * nothing the page holds may be keyed on a position. See
 * `src/lib/guest-book-pending.ts`.
 *
 * A caller's positional `resolve` map is folded onto the entries HERE, so that
 * the two index spaces stop existing the moment the row is written.
 */
function toPendingEntries(
	entries: Entry[],
	resolve: Record<string, string> | undefined,
): PendingEntry[] {
	return entries.map((raw, index) => {
		const answer = resolve?.[String(index)];
		return {
			id: randomUUID(),
			name: raw.name,
			...(raw.preferredName ? { preferredName: raw.preferredName } : {}),
			...(raw.email ? { email: raw.email } : {}),
			...(raw.phone ? { phone: raw.phone } : {}),
			...(answer
				? {
						resolve:
							answer === "new"
								? ({ kind: "new" } as const)
								: ({ kind: "existing", guestId: answer } as const),
					}
				: {}),
		};
	});
}

export const recordGuestBookTool: McpToolDefinition = {
	name: "record_guest_book",
	config: {
		title: "Record guest book",
		description:
			"Transcribe a page of the paper guest book against one meeting. This " +
			"writes NO guests and NO attendance: it returns a plan saying what each " +
			"line would do, plus a confirmUrl. Give the user that link — they open " +
			"it signed in, check the names and contact details against the page, fix " +
			"anything misread, and apply it there. Do not try to resolve an " +
			"`ambiguous` line yourself; the confirm page asks about it.",
		inputSchema,
	},
	handler: async (input, ctx) => {
		const args = z.object(inputSchema).parse(input);
		const { club, user } = await authorizeToken(ctx, args.clubId);

		// The old contract's second call. Refused before anything else runs, so a
		// stale client cannot reach a plan it has no way to apply.
		if (args.planHash) {
			throw new McpError("VALIDATION", PLAN_HASH_RETIRED_MESSAGE);
		}

		const countryCode = await loadClubDefaultCountryCode(club.clubId);

		// Plan BEFORE the row is written. `plan()` throws for a meeting that has
		// not happened yet, and a pending row for a page that cannot be recorded
		// at all is a link whose only content is an error — so a throw here leaves
		// nothing behind. A date naming zero or two meetings does NOT throw: that
		// is a blocking item the confirm page can show and the maintainer can act
		// on, so it gets a row and a link like any other preview.
		const {
			plan: p,
			blocking,
			meetingNumber,
		} = await plan(
			db,
			{ clubId: club.clubId, timezone: club.timezone },
			args,
			countryCode,
		);

		const entries = toPendingEntries(args.entries, args.resolve);
		const createdAt = new Date();
		const [row] = await db
			.insert(mcpPendingPlans)
			.values({
				clubId: club.clubId,
				// The discriminator every read of this row filters on (#812). One
				// table now serves every MCP write tool, so an id alone no longer
				// says what shape its payload has.
				tool: "record_guest_book",
				// The meeting DATE lives in the payload rather than a column, and
				// that is why #812 is a new table rather than a rename: a column
				// that is `NOT NULL` for this tool and meaningless for a tool
				// carrying many dates is two tables wearing one name. It is also
				// this flow's own rule restated — store what was ASKED and
				// re-resolve it on every render.
				payload: { meetingDate: args.meetingDate, entries },
				createdByUserId: user.id,
				createdAt,
				expiresAt: pendingPlanExpiresAt(createdAt),
			})
			.returning({ id: mcpPendingPlans.id });
		if (!row) throw new McpError("INTERNAL", "Failed to store that page.");

		const confirmUrl = guestBookConfirmUrl(appBaseUrl(), row.id);

		// No plan means the meeting could not be identified. There is nothing to
		// hash and nothing to approve — only the blocking item to answer.
		if (!p) {
			return {
				applied: false,
				pendingId: row.id,
				confirmUrl,
				plan: null,
				planHash: null,
				blocking: toPublicBlocking(blocking),
			};
		}

		return {
			applied: false,
			pendingId: row.id,
			confirmUrl,
			...toPublicPlan(p, meetingNumber),
			// The SECOND projection. `blocking` is a sibling of the plan, so
			// `toPublicPlan` cannot reach it, and an `AMBIGUOUS_GUEST` item's
			// candidates carry guests' real email and phone.
			blocking: toPublicBlocking(blocking),
			// Informational: the confirm page re-plans and computes its own. It is
			// returned so a caller can tell two previews of the same page apart.
			planHash: guestBookPlanHash({
				clubId: club.clubId,
				userId: user.id,
				plan: p,
			}),
		};
	},
};

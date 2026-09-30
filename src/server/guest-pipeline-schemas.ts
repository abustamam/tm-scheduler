// Input schemas for the guest pipeline, split out of `guest-pipeline.ts` so they
// are directly unit-testable. That module is a server-fn module, and
// `server-modules.guard.test.ts` allows those to export ONLY server fns and
// types — so a schema exported from there fails the guard, and a schema that
// cannot be imported cannot be tested.
//
// This module is pure: no `#/db`, no server fns. Client-safe, and exempt from
// that guard because the guard skips any file not containing the server-fn
// factory name. Keep that name out of this file, prose included — the check is
// a raw substring scan, so even a mention in a comment opts the file back in.
import { z } from "zod";

const uuid = z.string().uuid();

/**
 * The longest free text a guest field takes: the guest-book `name` and, since
 * #1050, a visiting Toastmaster's `homeClub`. ONE number, so the two free-text
 * guest columns an officer or a visitor can type into are bounded alike.
 */
export const GUEST_TEXT_MAX = 120;

/**
 * The PUBLIC, session-less guest-book submission (#239).
 *
 * Every bound here is load-bearing rather than cosmetic. `name` reaches
 * `namesAgree`, whose token-pairing search is bounded separately
 * (`MAX_MATCH_TOKENS`); this is the second layer. It is also the only thing
 * standing between an unauthenticated POST and an unbounded `text` column —
 * the guest-book form sets no `maxLength` of its own.
 *
 * `.max()` sits BEFORE `.optional().or(z.literal(""))` on the contact fields so
 * an omitted or empty value still parses; only a present, over-long one fails.
 */
export const guestBookSchema = z.object({
	clubId: uuid,
	name: z
		.string()
		.trim()
		.min(1, "Please enter your name.")
		.max(GUEST_TEXT_MAX, "That name is too long."),
	email: z.string().trim().email().max(200).optional().or(z.literal("")),
	phone: z.string().trim().max(40).optional().or(z.literal("")),
});

export type GuestBookInput = z.infer<typeof guestBookSchema>;

/**
 * Record an invite draft (#899). `.strict()` with NO actor field: the inviter is
 * the membership the gate resolves from the session, so a client-supplied
 * `actorMemberId` must fail parsing rather than be silently dropped.
 */
export const recordGuestInviteSchema = z
	.object({
		clubId: uuid,
		guestId: uuid,
		meetingId: uuid,
	})
	.strict();

export type RecordGuestInviteSchemaInput = z.infer<
	typeof recordGuestInviteSchema
>;

/**
 * The `guest_kind` enum's values (#1046), restated here because this module is
 * client-safe and `#/db/schema` is not something a dialog should import.
 * `guest-profile.test.ts` holds the two lists equal, so a value added to the
 * database enum fails a test instead of being unselectable.
 */
export const GUEST_KINDS = [
	"visitor",
	"visiting_toastmaster",
	"guest_speaker",
] as const;

export type GuestKind = (typeof GUEST_KINDS)[number];

export const GUEST_KIND_LABELS: Record<GuestKind, string> = {
	visitor: "Visitor",
	visiting_toastmaster: "Visiting Toastmaster",
	guest_speaker: "Guest speaker",
};

/**
 * What a guest's home club is STORED as, given their kind (#1050).
 *
 * A Visitor has no home club: they are not a Toastmaster anywhere, so a value
 * left over from when the row said "Visiting Toastmaster" is cleared rather
 * than kept invisibly (the dialog hides the field for a Visitor, so a kept
 * value could never be seen or corrected). Otherwise trimmed, and blank is
 * null. The length bound is the schema's; `applyUpdateGuestProfile` re-checks
 * it for a caller that skipped the schema.
 */
export function normalizeHomeClub(
	kind: GuestKind,
	homeClub: string | null | undefined,
): string | null {
	if (kind === "visitor") return null;
	const trimmed = (homeClub ?? "").trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * "Guest speaker, Laguna Speakers #1234" — how a non-visitor guest is described
 * next to their name. Null for a Visitor, who needs no caption.
 */
export function guestKindCaption(
	kind: GuestKind,
	homeClub: string | null,
): string | null {
	if (kind === "visitor") return null;
	const club = normalizeHomeClub(kind, homeClub);
	return club ? `${GUEST_KIND_LABELS[kind]}, ${club}` : GUEST_KIND_LABELS[kind];
}

/**
 * Set a guest's kind, home club and introducer (#1050). `.strict()` for the
 * same reason as `recordGuestInviteSchema`: nothing here names an actor, and an
 * unknown key should fail parsing rather than be dropped.
 *
 * `homeClub` is trimmed BEFORE the cap, so trailing spaces cannot push an
 * otherwise-legal name over it. `introducedByMemberId` is only shaped here —
 * whether it names a member of THIS club is a database question, answered by
 * `applyUpdateGuestProfile`.
 */
export const updateGuestProfileSchema = z
	.object({
		clubId: uuid,
		guestId: uuid,
		kind: z.enum(GUEST_KINDS),
		homeClub: z
			.string()
			.trim()
			.max(GUEST_TEXT_MAX, "That club name is too long.")
			.nullable()
			.optional(),
		introducedByMemberId: uuid.nullable().optional(),
	})
	.strict();

export type UpdateGuestProfileInput = z.infer<typeof updateGuestProfileSchema>;

/** One guest's row on VP Membership's "Brought by" view. */
export interface GuestIntroducerRow {
	guestId: string;
	introducedByMemberId: string | null;
	introducedByName: string | null;
}

/** A member and how many guests they brought (Easy-Speak's "Visitors Introduced"). */
export interface BroughtCount {
	memberId: string;
	name: string;
	count: number;
}

/**
 * Per-member "brought" counts, derived FROM the rows the page shows rather than
 * queried beside them, so the tally and the rows cannot disagree (#1050
 * criterion 3). Most brought first, then by name. A row whose introducer did
 * not resolve to a name (not a member of this club) is not counted: the page
 * could not show who it was, so a count naming them would be unexplainable.
 */
export function countBroughtByMember(
	rows: readonly GuestIntroducerRow[],
): BroughtCount[] {
	const byId = new Map<string, BroughtCount>();
	for (const r of rows) {
		if (!r.introducedByMemberId || r.introducedByName === null) continue;
		const hit = byId.get(r.introducedByMemberId);
		if (hit) hit.count += 1;
		else
			byId.set(r.introducedByMemberId, {
				memberId: r.introducedByMemberId,
				name: r.introducedByName,
				count: 1,
			});
	}
	return [...byId.values()].sort(
		(a, b) => b.count - a.count || a.name.localeCompare(b.name),
	);
}

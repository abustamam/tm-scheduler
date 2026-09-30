// A guest's kind, home club and introducer (#1050): the pure rules the dialog,
// VP Membership and the server write all share. Client-safe — no `#/db`.

/**
 * The longest free text a guest field takes: the guest-book `name` and, since
 * #1050, a visiting Toastmaster's `homeClub`. ONE number, so the two free-text
 * guest columns an officer or a visitor can type into are bounded alike.
 */
export const GUEST_TEXT_MAX = 120;

/** The one refusal for a home club over {@link GUEST_TEXT_MAX}. */
export const HOME_CLUB_TOO_LONG_MESSAGE = "That club name is too long.";

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

/** The three #1046 columns, as every read and write of them carries them. */
export interface GuestProfileFields {
	kind: GuestKind;
	homeClub: string | null;
	introducedByMemberId: string | null;
}

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
 * Whether the dialog's three profile fields differ from what it loaded, once
 * both are normalized the way the server would store them. The dialog skips
 * the profile write when they do not (#1060 review): a save made to fix a name
 * must not rewrite a kind, home club or introducer another officer set since
 * the dialog opened.
 */
export function profileFieldsChanged(
	loaded: GuestProfileFields,
	current: GuestProfileFields,
): boolean {
	return (
		loaded.kind !== current.kind ||
		normalizeHomeClub(loaded.kind, loaded.homeClub) !==
			normalizeHomeClub(current.kind, current.homeClub) ||
		(loaded.introducedByMemberId ?? null) !==
			(current.introducedByMemberId ?? null)
	);
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

// Pure, client-safe helper (#37) that composes a person-to-person nudge for a
// role — a `wa.me` and/or `mailto:` draft a VPE opens in their OWN app and then
// edits and sends. NO `#/db` here so the meeting-detail client route can call it.
// The app only ever DRAFTS; the human sends.

import { mailtoHref } from "#/lib/mailto";
import type { RoleIdentity } from "#/lib/meeting-roles";
import { greetingName } from "#/lib/person-name";
import type { Platform } from "#/lib/platform";
import {
	type DutyContext,
	dutiesForRole,
	personalMeetingHref,
	type RoleDuty,
} from "#/lib/role-duties";
import { whatsappHref } from "#/lib/whatsapp";

export type NudgeMode = "confirm" | "recruit" | "attendance" | "arriving";

interface NudgeInputBase {
	name: string;
	/**
	 * What this person is actually called, when it isn't the first token of
	 * `name` (#486). Absent/null/blank falls back to that first token.
	 */
	preferredName?: string | null;
	/** E.164-ish free text; may be null/absent. */
	phone?: string | null;
	email?: string | null;
	/** Already formatted friendly, in the club's timezone (footerDate). */
	meetingDate: string;
	/** Absolute public meeting URL (caller prepends window.location.origin). */
	shareUrl: string;
	/**
	 * Which WhatsApp entry point to link (#485). Defaults to `"mobile"` — the
	 * historical `wa.me` behavior — so a caller that cannot detect the platform
	 * is no worse off than before. `detectPlatform` (`#/lib/platform`) supplies
	 * it in the browser.
	 */
	platform?: Platform;
}

/**
 * DISCRIMINATED on `mode`, not one shape with an optional `roleName`. The
 * `attendance` mode asks whether the member is coming AT ALL, so it has no role
 * to name — but making `roleName` optional for that reason would ALSO make it
 * optional for `confirm` and `recruit`, whose messages interpolate it directly.
 * A caller omitting it would then typecheck and draft "just confirming you're
 * our undefined for the …" into a message a VPE taps to send. This keeps the
 * field REQUIRED exactly where it is read and absent where it is not.
 */
export type NudgeInput =
	| (NudgeInputBase & { mode: "attendance" })
	// SEPARATE constituent from `attendance` rather than `mode: "attendance" |
	// "arriving"` on one, which is a type-level trap: TS removes a union member
	// only when its whole discriminant is excluded, so two role-less modes sharing
	// one constituent survived both early returns below and `i.roleName` stopped
	// type-checking on the arm that has it.
	| (NudgeInputBase & { mode: "arriving" })
	| (NudgeInputBase & {
			mode: "confirm" | "recruit";
			/** The role being asked about. Role-specific asks stay on the slot
			 *  cards and in "Nudge someone" (spec D5). */
			roleName: string;
			/**
			 * What this role still OWES (#667), already filtered — pass
			 * `outstandingDuties(...)` below, never `dutiesForRole` raw.
			 *
			 * On the role-carrying arms ONLY, for the reason the union itself
			 * exists: `attendance` and `arriving` address someone with no role, so
			 * a role's duties can never be theirs to do. An optional field on the
			 * base would typecheck on both and hand a duty clause to a draft whose
			 * sentence names no role at all.
			 *
			 * A DONE duty must not appear here. Suppression is the requirement
			 * rather than a nicety: a nudge about a job already finished teaches
			 * the recipient these messages are not worth reading, which costs more
			 * than the nudge gains.
			 */
			duties?: readonly RoleDuty[];
			/**
			 * The recipient's OWN meeting page (#665), which this draft links to
			 * instead of the public agenda so they can act in one tap. Build it
			 * with `personalNudgeUrl` below.
			 *
			 * Optional, and the fallback is load-bearing: a slot can be held by a
			 * GUEST, who has no `members` row and therefore no `?as=` identity to
			 * seed. That draft still has a role to confirm, so it keeps `shareUrl`
			 * rather than losing its link.
			 */
			personalUrl?: string | null;
	  });

export interface Nudge {
	message: string;
	/** Omitted when the target has no phone. */
	whatsappUrl?: string;
	/** Omitted when the target has no email. */
	mailtoUrl?: string;
}

function messageFor(i: NudgeInput): string {
	// Greet by first/preferred name — "Hi Zabihullah Kogyani," reads like a mail
	// merge, which undercuts a draft whose whole point is that a human wrote it.
	const who = greetingName(i);
	if (i.mode === "attendance") {
		return `Hi ${who}, are you able to make our ${i.meetingDate} meeting? Agenda here: ${i.shareUrl}`;
	}
	// A SEPARATE mode rather than a reuse of `attendance`, because the two are sent
	// at different moments and only one of them is still a question about the
	// future. Roll mode renders during the meeting — the attendance rail's roll rows
	// show contact right up until the meeting is `completed` — so the `attendance`
	// draft was being sent from the room at 7:45pm asking "are you able to make our
	// Tuesday 18 August meeting?", under the subject "Are you coming?", about the
	// meeting that was running as they read it.
	if (i.mode === "arriving") {
		return `Hi ${who}, we've started our ${i.meetingDate} meeting — are you on your way? Agenda here: ${i.shareUrl}`;
	}
	// The personal page when the recipient has one, else the public agenda. A
	// BLANK string counts as absent, not as a link: the surfaces that build this
	// fall back to `""` for a viewer who may not have it (the agenda's own
	// `shareUrl` prop does the same), and `??` would happily draft "Details: ".
	const link = i.personalUrl || i.shareUrl;
	const owed = i.duties ?? [];
	if (i.mode === "confirm") {
		// TWO templates rather than one with an optional tail, because the
		// no-duty draft has to stay BYTE-IDENTICAL to the one officers already
		// send — five of the nine standard roles have no data-backed duty, so
		// that is the common case, and it is the case an interpolated empty
		// clause leaves reading "…meeting — you'll also need to . Details:".
		return owed.length === 0
			? `Hi ${who}, just confirming you're our ${i.roleName} for the ${i.meetingDate} meeting. Details: ${link}`
			: `Hi ${who}, just confirming you're our ${i.roleName} for the ${i.meetingDate} meeting — you'll also need to ${dutyClauseList(owed)}. Confirm and do that here: ${link}`;
	}
	// "You'd", not "you'll": a recruit draft is asking, and stating what they
	// WILL do to someone who has not said yes is the same presumption the
	// `attendance`/`arriving` split exists to avoid one mode over.
	return owed.length === 0
		? `Hi ${who}, would you be open to taking ${i.roleName} at our ${i.meetingDate} meeting? Info here: ${link}`
		: `Hi ${who}, would you be open to taking ${i.roleName} at our ${i.meetingDate} meeting? You'd also need to ${dutyClauseList(owed)}. Info here: ${link}`;
}

/**
 * The owed duties as ONE readable phrase: "set the meeting theme", or "set the
 * meeting theme and add your speech details", or "a, b and c".
 *
 * Joined here rather than rendered one sentence per duty, because a draft that
 * repeats "you'll also need to …" three times reads like a form letter — and
 * the whole premise of these drafts is that a human wrote them.
 */
function dutyClauseList(duties: readonly RoleDuty[]): string {
	const clauses = duties.map((duty) => duty.clause);
	if (clauses.length < 2) return clauses[0] ?? "";
	return `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}`;
}

/**
 * The duties this role still owes, decided by the registry's OWN `done` (#660)
 * rather than by a predicate written here.
 *
 * This one-line filter is the whole point of the issue's "the draft and the
 * checklist cannot disagree": the personal page's checklist calls
 * `duty.done(ctx)` on the same objects from the same map, so "is the theme
 * set?" is answered once, in `role-duties.ts`, for both surfaces. A caller that
 * hand-rolled `if (!meeting.theme)` would read the app's own `TBA` sentinel as
 * a finished speech on the speech duty and diverge silently.
 *
 * It lives beside the draft builder rather than in the registry because it is
 * the shape `buildNudge` takes; the registry stays the thing that knows what a
 * duty IS.
 */
export function outstandingDuties(
	role: RoleIdentity,
	ctx: DutyContext,
): readonly RoleDuty[] {
	return dutiesForRole(role).filter((duty) => !duty.done(ctx));
}

/**
 * What ONE SLOT's holder still owes: the role identity and the duty context a
 * slot resolves to, in one place.
 *
 * The three fields go together and are easy to get half right — `speechTitle`
 * is per-SLOT (a member can hold two speaker slots, and one finished title must
 * not silence the draft about the other) while `theme` and `wordOfTheDay` are
 * meeting-wide. Spelling that shape at each call site is how the agenda card
 * and the rail's map come to disagree about what a slot owes.
 */
export function outstandingDutiesForSlot(
	slot: {
		roleName: string;
		roleKey?: string | null;
		speechTitle?: string | null;
	},
	meeting: Pick<DutyContext, "theme" | "wordOfTheDay" | "tableTopicsNotes">,
): readonly RoleDuty[] {
	return outstandingDuties(
		{ roleName: slot.roleName, roleKey: slot.roleKey },
		{
			theme: meeting.theme,
			wordOfTheDay: meeting.wordOfTheDay,
			tableTopicsNotes: meeting.tableTopicsNotes,
			speechTitle: slot.speechTitle,
		},
	);
}

/**
 * Outstanding duties keyed by MEMBER, for the attendance rail (#667).
 *
 * The rail cannot derive them for itself: a row carries a `PanelRole`, which is
 * a short code and a base role NAME and nothing else — no key, no speech title
 * — so the route builds this from the same `slots` array it hands
 * `buildPanelRoleMap` and passes it down.
 *
 * FIRST slot wins, and that is not a tidiness choice. `buildPanelRoleMap` gives
 * a double-booked member the FIRST slot's role name ("slots arrives ordered by
 * the role's sortOrder, so that is the more prominent role"), and the rail's
 * draft names exactly that role. Built last-wins, this map would name one role
 * in the sentence and list the OTHER role's duty in the same breath.
 *
 * A `Map`, not an object, FOLLOWING the rule `DUTIES_BY_ROLE_KEY` states one
 * module over: "an object answers for `__proto__` and `constructor`", so a key
 * we never wrote resolves to something that is not a duty list at all. The keys
 * here are member ids, which are uuids today and so cannot be either — but the
 * type is the half that travels, and as a `Record` the PANEL would index a
 * caller's plain object with an id it got from a row. A `Map` makes failing
 * closed on an unknown key structural rather than an argument about where ids
 * come from, which is exactly the sibling's reasoning.
 */
export function outstandingDutiesByMember(
	slots: readonly {
		assigneeId: string | null;
		roleName: string;
		roleKey?: string | null;
		speechTitle?: string | null;
	}[],
	meeting: Pick<DutyContext, "theme" | "wordOfTheDay" | "tableTopicsNotes">,
): ReadonlyMap<string, readonly RoleDuty[]> {
	const byMember = new Map<string, readonly RoleDuty[]>();
	for (const slot of slots) {
		if (!slot.assigneeId || byMember.has(slot.assigneeId)) continue;
		byMember.set(slot.assigneeId, outstandingDutiesForSlot(slot, meeting));
	}
	return byMember;
}

/**
 * What a surface needs to address the personal meeting page to ONE member.
 *
 * One object rather than three loose strings, because the three are only ever
 * correct together and a component that took them apart could be wired with a
 * club slug in the meeting slot and still typecheck.
 */
export interface PersonalNudgeBase {
	/** Absolute origin, or `""` during SSR — the same split `shareUrl` makes,
	 *  for the same reason (`window` exists only on the client). */
	origin: string;
	/** The club's URL segment — the slug, as the route reads it. */
	clubId: string;
	/** The meeting's `$meetingId` URL segment: a club-local date key, a
	 *  date-HHmm key, or a uuid. All three resolve. */
	meetingKey: string;
}

/**
 * The link a role draft points at: the recipient's own meeting page (#665),
 * carrying the `?as=` seed that tells it whose page it is.
 *
 * The PATH comes from `personalMeetingHref` in the duty registry, never a
 * literal assembled here — the registry hands out the links INTO the duty
 * editors, so it owns the link back out, and a second spelling of `/me` is
 * exactly the drift that leaves a nudge pointing at a 404 after a route move.
 *
 * `?as=` grants nothing (ADR-0026): it seeds the same unverified identity the
 * page's own "Who are you?" picker sets, and only when the browser holds no
 * conflicting pick of its own.
 */
export function personalNudgeUrl(
	base: PersonalNudgeBase,
	memberId: string,
): string {
	const path = personalMeetingHref({
		clubId: base.clubId,
		meetingId: base.meetingKey,
	});
	// The id is a uuid from our own roster, so the encode is belt-and-braces —
	// but it is the one value here that did not come from a route segment, and
	// an unescaped `&` in a query value is how a link silently addresses
	// somebody else.
	return `${base.origin}${path}?as=${encodeURIComponent(memberId)}`;
}

function subjectFor(i: NudgeInput): string {
	if (i.mode === "attendance") return `Are you coming? — ${i.meetingDate}`;
	if (i.mode === "arriving") return `Are you on your way? — ${i.meetingDate}`;
	return i.mode === "confirm"
		? `Confirming your ${i.roleName} role — ${i.meetingDate}`
		: `Open ${i.roleName} role — ${i.meetingDate} meeting?`;
}

export function buildNudge(input: NudgeInput): Nudge {
	const message = messageFor(input);
	const nudge: Nudge = { message };

	// `whatsappHref` returns null when there is no number, which is exactly when
	// `whatsappUrl` should be absent from the result.
	const whatsappUrl = whatsappHref(
		input.phone,
		input.platform ?? "mobile",
		message,
	);
	if (whatsappUrl) nudge.whatsappUrl = whatsappUrl;

	if (input.email) {
		// `mailtoHref` for the ADDRESS, then this module's own headers. Raw
		// interpolation here was the fourth and worst `mailto:` sink: the three
		// display links elsewhere are addresses a reader looks at, while this is a
		// pre-composed draft a VPE taps to SEND. A stored
		// `ada@club.org?bcc=attacker@evil.com` produced a live `bcc` header AND
		// swallowed this app's own `subject=` into the injected `body`, so the
		// message that opened was neither private nor the one it claimed to be.
		//
		// Reachable: `members.email` has a free-text writer (`bulkImportSchema` is
		// `z.string()`, no `.email()`), and `NudgeButtons` is fed that column via
		// `slot.holderEmail` on the meeting agenda and the recruit picker.
		//
		// `mailtoHref` escapes `?`, `&` and `#` and leaves `@` alone, so the `?`
		// that opens the header section below is the FIRST one in the URL — which
		// is the whole property this needs. `mailto.guard.test.ts` fails if a fifth
		// sink appears.
		nudge.mailtoUrl = `${mailtoHref(input.email)}?subject=${encodeURIComponent(
			subjectFor(input),
		)}&body=${encodeURIComponent(message)}`;
	}

	return nudge;
}

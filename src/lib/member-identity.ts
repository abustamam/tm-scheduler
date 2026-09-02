import { useCallback, useSyncExternalStore } from "react";

export interface StoredMember {
	id: string;
	name: string;
}
export const memberKey = (clubId: string) => `gavelup:member:${clubId}`;

export function readStoredMember(clubId: string): StoredMember | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(memberKey(clubId));
		if (!raw) return null;
		const v = JSON.parse(raw);
		return typeof v?.id === "string" && typeof v?.name === "string" ? v : null;
	} catch {
		return null;
	}
}
export function storeMember(clubId: string, m: StoredMember) {
	localStorage.setItem(memberKey(clubId), JSON.stringify(m));
	emitChange();
}
export function clearStoredMember(clubId: string) {
	localStorage.removeItem(memberKey(clubId));
	emitChange();
}

// ---------------------------------------------------------------------------
// Shared external store: every `useCurrentMember` instance subscribes here, so
// a `setMember`/`clearMember` in one component (e.g. the home's "not you?")
// immediately re-renders the gate and any other consumer — and cross-tab
// `storage` events are picked up too.
// ---------------------------------------------------------------------------
const listeners = new Set<() => void>();
function emitChange() {
	for (const l of listeners) l();
}
function subscribe(cb: () => void) {
	listeners.add(cb);
	const onStorage = (e: StorageEvent) => {
		if (e.key === null || e.key.startsWith("gavelup:member:")) cb();
	};
	if (typeof window !== "undefined") {
		window.addEventListener("storage", onStorage);
	}
	return () => {
		listeners.delete(cb);
		if (typeof window !== "undefined") {
			window.removeEventListener("storage", onStorage);
		}
	};
}

// `useSyncExternalStore` requires a stable snapshot reference when nothing
// changed, or it re-renders forever. Cache the parsed value per club and only
// re-parse when the raw localStorage string actually differs.
const snapshotCache = new Map<
	string,
	{ raw: string | null; value: StoredMember | null }
>();
function getSnapshot(clubId: string): StoredMember | null {
	if (typeof localStorage === "undefined") return null;
	const raw = localStorage.getItem(memberKey(clubId));
	const cached = snapshotCache.get(clubId);
	if (cached && cached.raw === raw) return cached.value;
	const value = readStoredMember(clubId);
	snapshotCache.set(clubId, { raw, value });
	return value;
}

/** SSR-safe hook backed by a shared store. `member` is null on the server and
 * during hydration, then reflects localStorage; all instances stay in sync. */
export function useCurrentMember(clubId: string) {
	const member = useSyncExternalStore(
		subscribe,
		() => getSnapshot(clubId),
		() => null,
	);
	const setMember = useCallback(
		(m: StoredMember) => storeMember(clubId, m),
		[clubId],
	);
	const clearMember = useCallback(() => clearStoredMember(clubId), [clubId]);
	return { member, setMember, clearMember };
}

/** What the route should do about a `?as=<memberId>` param (#665). */
export interface AsSeedDecision {
	/** The identity to write to localStorage, or null to write nothing. */
	seed: StoredMember | null;
	/** Whether to replace-navigate the param out of the URL. */
	stripParam: boolean;
}

/**
 * Decide what a `?as=<memberId>` link does to the stored identity.
 *
 * `?as=` is an identity SEEDER, not an auth path: it writes into the same
 * localStorage identity the anonymous roster pick already sets, so everything
 * downstream (the self-assert grants, `claimSlot`, `setPlannedAttendance`)
 * works unchanged. There is no new authorization here and no token model.
 *
 * `candidate` must already have been validated against the club's roster
 * SERVER-side — it is `loadPublicPersonalMeetingView`'s resolved member, or
 * null when that reader rejected the id. Passing an unvalidated id would write
 * junk into the visitor's identity and make every later self-assert fail
 * confusingly.
 *
 * Three rules, and the first is the one worth stating:
 *
 * · **A signed-in member always wins, and nothing is written.** The gate already
 *   resolves `sessionMember ?? picked`, so a session identity would win the
 *   render regardless — but seeding anyway would quietly rewrite the localStorage
 *   pick underneath it, and that pick resurfaces the moment they sign out. The
 *   visible consequence, worth a line in the PR: an officer opening a member's
 *   link to test it sees their OWN view, not that member's.
 * · An anonymous visitor's existing DIFFERENT pick is NOT overwritten, and this
 *   is the rule that took the longest to get right. The tempting argument is
 *   that `?as=` is "identical to the honour-system roster pick this product
 *   already runs on" — it is not, in two ways. The roster pick is a deliberate
 *   act at a dialog; this is a side effect of opening a URL someone forwarded.
 *   And what gets written is not scoped to this page or this visit: it is the
 *   club-WIDE `gavelup:member:<club>` key that then drives `claimSlot`,
 *   `releaseSlot`, the season grid's availability toggles and the activity-feed
 *   attribution behind all of them. So Alice tapping a link a club-mate
 *   forwarded, carrying `?as=<bob>`, would become Bob everywhere in that club
 *   until she noticed, and the next role she signed up for would be Bob's. The
 *   page still RENDERS as the `?as=` member for that visit — the route reads
 *   the target from the param, not from localStorage — so refusing the durable
 *   write costs the intended flow nothing.
 * · A first-tap visitor with NO pick is seeded, which is the intended flow, and
 *   so is a re-tap by someone already picked as that same member. These links
 *   belong in a 1:1 message, never a broadcast channel.
 * · A REJECTED id still strips the param. Leaving it in the URL means a re-tap
 *   retries a known-bad id and the bad param rides along into history and any
 *   re-share.
 */
export function resolveAsSeed(args: {
	asParam: string | null | undefined;
	sessionMember: StoredMember | null;
	candidate: StoredMember | null;
	/** The identity ALREADY stored for this club in this browser, if any. */
	existingPick: StoredMember | null;
}): AsSeedDecision {
	if (!args.asParam) return { seed: null, stripParam: false };
	if (args.sessionMember) return { seed: null, stripParam: true };
	// The candidate must BE the id the param named. The caller derives both from
	// the same fetch, so today they always agree — but nothing enforces that, and
	// the one shape where they diverge is ugly: if a session appears or drops
	// between the fetch and this call, the candidate is the SESSION member and
	// seeding it would write that identity under the authority of a `?as=` the
	// user never had. Checking here makes the rule the function's own, provable
	// in isolation, instead of an invariant a route comment merely asserts.
	if (args.candidate?.id !== args.asParam) {
		return { seed: null, stripParam: true };
	}
	// A DIFFERENT identity already lives in this browser. Seed NOTHING — and do
	// NOT strip either, which is the half that is easy to get wrong.
	//
	// `targetMemberId` falls back to the stored pick the moment `?as=` leaves the
	// URL, so stripping here would flip the page to the OTHER member: Priya taps
	// her own link on a phone her club-mate used, and reads "Hi Omar" over Omar's
	// roles, one tap away from answering as him. That is the same wrong-person
	// write this rule exists to prevent, pointing the other way. Keeping the
	// param lets the page stay the link's member for this visit while the durable
	// club-wide identity stays untouched.
	if (args.existingPick && args.existingPick.id !== args.candidate.id) {
		return { seed: null, stripParam: false };
	}
	return { seed: args.candidate, stripParam: true };
}

/**
 * The member to act as on a public route (#317). A signed-in member of the club
 * (shell-wrapped) passes their `session` identity (id + display name), which
 * takes precedence over the localStorage pick; an anonymous visitor passes
 * `null` and gets the localStorage-picked member. `source` lets the UI hide the
 * "not you? / re-pick" affordance for a signed-in member (whose identity is the
 * session, not a localStorage choice they can clear).
 */
export function useEffectiveMember(
	clubId: string,
	session: StoredMember | null,
) {
	const picked = useCurrentMember(clubId);
	if (session) {
		return { ...picked, member: session, source: "session" as const };
	}
	return { ...picked, source: "anon" as const };
}

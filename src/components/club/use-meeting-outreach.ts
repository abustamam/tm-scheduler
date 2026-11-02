import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { showWriteError } from "#/components/write-error-toast";
import { clearRefusedMessage, type PlanStatus } from "#/lib/attendance-panel";
import { notComingToast } from "#/lib/role-duty-copy";
import {
	clearPlannedAttendance,
	setPlannedAttendance,
} from "#/server/attendance-plan";
import { getLineupBlastAccess } from "#/server/lineup-blast";
import { clearContacted, setContacted } from "#/server/outreach";
import type { PendingDecline } from "./decline-release-dialog";
import type { HeldRolesByMember, MeetingDetail } from "./use-meeting-types";

/**
 * The meeting page's outreach domain (#1476): the plan ladder's writes
 * (`writeRung`, `commitRung`, `markAsked`), the decline confirm, the member's own
 * "I'll be there" strip, the contacted marks on the agenda's recruit picker, and
 * the lineup blast's access read.
 *
 * Everything another domain owns comes in as a parameter: `declineFreesRoles`
 * from the cover hook, the ladder and roster from the roll hook. This hook never
 * calls another `use-meeting-*` hook.
 */
export function useMeetingOutreach(args: {
	meetingId: string;
	/** The club's uuid, stamped on a contacted mark. */
	clubUuid: string;
	myId: string | null;
	isSignedIn: boolean;
	isTmod: boolean;
	holdsRole: boolean;
	cancelled: boolean;
	previewAsMember: boolean;
	effectiveCanManage: boolean;
	needsTmodPlan: boolean;
	tmodPlanKey: readonly ["tmod-plan", string, string | null];
	/** The ladder this viewer may see (officer payload, TMOD fetch, or `[]`). */
	effectivePlan: MeetingDetail["plan"];
	/** The public array a plain member's own row lives on. */
	answeredRungs: MeetingDetail["answeredRungs"];
	panelRosterForMode: { id: string; name: string }[];
	heldRolesByMember: HeldRolesByMember;
	declineFreesRoles: (memberId: string) => boolean;
}) {
	const {
		meetingId,
		clubUuid,
		myId,
		isSignedIn,
		isTmod,
		holdsRole,
		cancelled,
		previewAsMember,
		effectiveCanManage,
		needsTmodPlan,
		tmodPlanKey,
		effectivePlan,
		answeredRungs,
		panelRosterForMode,
		heldRolesByMember,
		declineFreesRoles,
	} = args;
	const router = useRouter();
	const queryClient = useQueryClient();

	// Optimistic rung overrides, keyed by member. `undefined` = no override, so
	// a member can be optimistically cleared to `null` and still be
	// distinguishable from "not touched" — which `??` alone cannot express.
	const [rungOverride, setRungOverride] = useState<
		Record<string, PlanStatus | null>
	>({});
	// Members with a plan write currently in flight — a ref, not state, since
	// only `writeRung` and the reconciling effect below touch it and neither
	// should re-render on it. The effect drops any override for a member NOT in
	// this map the moment `plan` changes, so a write that is still pending
	// cannot be evicted by a payload that hasn't caught up to it yet (whole-branch
	// review I2).
	//
	// REFCOUNTED, not a `Set`: two writes can be outstanding for the SAME member
	// at once, because an officer's own row carries two independent controls with
	// two independent busy flags that cannot see each other — the panel's chip
	// (`pendingId`) and the personal strip's ("I'll be there"/`myStatusBusy`).
	// With a `Set` the second `add` is a no-op and the FIRST write's release
	// clears the entry while the second is still outstanding, which hands the
	// effect an override it is free to evict before its write has landed.
	const pendingWritesRef = useRef<Map<string, number>>(new Map());
	function retainPending(memberId: string) {
		const m = pendingWritesRef.current;
		m.set(memberId, (m.get(memberId) ?? 0) + 1);
	}
	function releasePending(memberId: string) {
		const m = pendingWritesRef.current;
		const left = (m.get(memberId) ?? 1) - 1;
		if (left > 0) m.set(memberId, left);
		else m.delete(memberId);
	}
	// Busy guard against a rapid double-tap on the strip's OWN write — the same
	// class of race the panel's per-row `pendingId` already guards
	// (meeting-attendance-panel.tsx:136, 174-181). Without this, tapping "I'll
	// be there" then "undo" before the first request resolves fires
	// `setPlannedAttendance` and `clearPlannedAttendance` concurrently with no
	// ordering guarantee, and an out-of-order resolution leaves the persisted
	// rung disagreeing with the member's last tap.
	const [myStatusBusy, setMyStatusBusy] = useState(false);
	// The decline the officer (or the member) has picked but not yet confirmed
	// (#663). Null while nothing is pending. Held HERE rather than in the panel
	// because BOTH surfaces that write a rung on this page go through
	// `writeRung` — the rail's chips and the personal strip's "Can't make it" —
	// and a confirm wired to only one of them would leave the other releasing
	// roles silently.
	const [pendingDecline, setPendingDecline] = useState<PendingDecline | null>(
		null,
	);
	// The confirm's OWN in-flight flag. `writeRung` returns as soon as the dialog
	// opens, so the panel's `pendingId` and the strip's `myStatusBusy` have both
	// cleared by the time the officer answers — the confirmed write would
	// otherwise be the one write on this page guarded by nothing.
	const [declineBusy, setDeclineBusy] = useState(false);
	const [lineupOpen, setLineupOpen] = useState(false);

	// What the caller asserts about THEMSELVES, so the server can check it against
	// the meeting's Toastmaster slot (#576). Sent only on the non-officer path:
	// an officer is identified by their session and `resolveWriteActor` ignores
	// any claim from them anyway, so including it would be noise that reads like
	// it matters. Omitted entirely when there is no identity, which leaves the
	// server's self-only arm exactly as it was.
	//
	// This is an ASSERTION, never proof — the server club-scopes it and compares
	// it to the slot before granting anything. Sending it cannot elevate a member
	// who is not the TMOD.
	const actorClaim = !effectiveCanManage && myId ? { actorMemberId: myId } : {};

	// Lineup blast (#1024): club admins, officers and this meeting's Toastmaster.
	// `canManage` covers a stored admin and an officer with an open term, so a
	// signed-in member or a self-identified Toastmaster asks the server, which decides through the same
	// `mayDraftLineupBlast` rule its draft fn enforces.
	const { data: lineupAccess } = useQuery({
		queryKey: ["lineup-blast-access", meetingId, myId] as const,
		queryFn: () =>
			getLineupBlastAccess({
				data: { meetingId, selfMemberId: myId },
			}),
		enabled:
			!effectiveCanManage &&
			(!previewAsMember || isTmod) &&
			(isSignedIn || isTmod),
	});
	// Never on a cancelled meeting (#1057): there is no lineup to blast, and the
	// loader refuses the draft with `MEETING_CANCELLED_MESSAGE` anyway.
	const canLineupBlast =
		!cancelled &&
		(effectiveCanManage ||
			((!previewAsMember || isTmod) && lineupAccess?.allowed === true));

	async function writeRung(
		memberId: string,
		next: PlanStatus | null,
		via: "nudge" | "manual" = "manual",
	) {
		// #663: EVERY decline asks first. Deliberately not gated on the page
		// believing this member holds a role — `heldRolesByMember` comes from
		// loader data and the rail does not poll (CODING_STANDARDS.md), so a slot
		// claimed since the page rendered is absent from it while the server frees
		// it anyway. Gating on it skipped the confirm on exactly the case where
		// the officer has the least idea what is about to happen, which is the
		// sibling surface's documented first-cut bug (`personal-meeting-body.tsx`).
		// A toast afterwards is a receipt, not consent.
		//
		// Returns WITHOUT writing and without touching `rungOverride`, so
		// cancelling leaves no optimistic chip to roll back.
		if (next === "not_coming") {
			setPendingDecline({
				memberId,
				name:
					heldRolesByMember[memberId]?.name ??
					panelRosterForMode.find((r) => r.id === memberId)?.name ??
					"this member",
				roleLabels: heldRolesByMember[memberId]?.labels ?? [],
				self: memberId === myId,
				willRelease: declineFreesRoles(memberId),
			});
			return;
		}
		return commitRung(memberId, next, via);
	}

	async function commitRung(
		memberId: string,
		next: PlanStatus | null,
		via: "nudge" | "manual" = "manual",
		/** The confirm dialog was shown and answered (#663). DEFAULT FALSE, and
		 *  only `DeclineReleaseDialog`'s own action passes true — every other
		 *  caller here reaches this through `writeRung`, which cannot get past the
		 *  dialog for a `not_coming`. The server treats an absent flag as "record
		 *  the rung, free nothing"; see the field's note in `attendance-plan.ts`. */
		releaseHeldRoles = false,
	) {
		// #762: the opt-in survives only if this viewer's decline would actually
		// free anything. It cannot for an anonymous roster pick, and the server
		// refuses the REQUEST rather than downgrading it — so sending the flag
		// anyway loses the member's answer entirely instead of recording it.
		//
		// Re-entered with the flag defaulted, so the rung still lands by exactly
		// the path every other caller takes. One level only: the inner call passes
		// no flag, so the condition cannot hold twice.
		if (releaseHeldRoles && !declineFreesRoles(memberId)) {
			return commitRung(memberId, next, via);
		}
		// Roll back to what the UI was ACTUALLY showing, not the loader's
		// snapshot: nothing here awaits an invalidate before this runs, and for a
		// plain member `effectivePlan` is ALWAYS `[]` — so a lookup in it alone
		// would restore the very value the failed write already overwrote, every
		// time (whole-branch review I1). Check the override first (a second write
		// racing the same row), then `effectivePlan` (the ladder an officer or
		// this meeting's TMOD can see), then `answeredRungs` (the public array a
		// plain member's own row lives on).
		const previous =
			rungOverride[memberId] !== undefined
				? rungOverride[memberId]
				: (effectivePlan.find((p) => p.memberId === memberId)?.status ??
					answeredRungs.find((r) => r.memberId === memberId)?.status ??
					null);
		setRungOverride((o) => ({ ...o, [memberId]: next }));
		retainPending(memberId);
		try {
			const written = await (next === null
				? clearPlannedAttendance({
						data: { memberId, meetingId, ...actorClaim },
					})
				: setPlannedAttendance({
						data: {
							memberId,
							meetingId,
							status: next,
							via,
							releaseHeldRoles,
							...actorClaim,
						},
					}));
			// #663: say what actually happened. The confirm named the roles BEFORE
			// the write; this is the receipt, and it reads the SERVER's count rather
			// than the labels the dialog showed — the arm gate lives server-side, so
			// the client's prediction is the thing that could be wrong.
			const released = "released" in written ? written.released : 0;
			// A "No answer" the server declined (`cleared: false`) leaves the row
			// exactly as it was, and the refetch below then shows that — a control
			// that did nothing and said nothing. On another member's answer it is
			// because a member's answer is cleared by that member, or by an officer
			// on the season grid, and not from here: say so, and point at the pick
			// that does what an officer or Toastmaster usually means.
			const refusedClear =
				"cleared" in written
					? clearRefusedMessage({
							cleared: written.cleared,
							memberId,
							myId,
							previous,
						})
					: null;
			if (refusedClear) toast.message(refusedClear);
			if (memberId === myId && next === "not_coming") {
				// The viewer's own decline (#1280): the strip chip and the roster land
				// here. `holdsRole` (this meeting's slots) is for COPY only, and only
				// when the server freed nothing.
				const t = notComingToast(released, holdsRole);
				toast.success(t.text, { duration: t.duration });
			} else if (released > 0) {
				toast.success(
					released === 1
						? "Not coming — role freed."
						: "Not coming — roles freed.",
				);
			}
			// Fire-and-forget, NOT awaited: the override already holds the value
			// this write just committed, so nothing on screen is waiting on this
			// resolving. But SOME invalidate has to fire, or `contactedMemberIds` /
			// `unavailableMemberIds` (both derived from loader values — `plan` /
			// `unavailableMembers`) go stale for the recruit picker and the assign
			// sheet after this tap (whole-branch review I3). This also feeds the
			// reconciling effect below its own trigger, rather than relying on some
			// unrelated action to refresh `plan`.
			//
			// The pending mark is released when this INVALIDATE settles, not when
			// the write above resolved. Those are different moments, and between
			// them the reconciling effect would happily evict this override: `plan`
			// gets a fresh identity on every loader run, and this route has ~15
			// other `router.invalidate()` call sites (meta save, minutes, add-role,
			// lifecycle, every vote action). A loader request that started before
			// this write committed, landing in that window, reverts a chip the
			// officer just tapped — which reads as "it didn't save", so they tap
			// again.
			// The TMOD's ladder lives in a QUERY, not loader data, so
			// `router.invalidate()` alone would leave it stale — and the
			// reconciling effect below, seeing a fresh payload, would then drop the
			// override back onto that stale row and visibly undo the officer's own
			// tap. No-op for an officer, whose ladder is on the payload.
			if (needsTmodPlan) {
				void queryClient.invalidateQueries({ queryKey: tmodPlanKey });
			}
			void router
				.invalidate()
				// A failed refetch does NOT undo the write: the override still holds
				// the committed value, so the panel stays correct. What goes stale is
				// `contactedMemberIds` / `unavailableMemberIds` elsewhere on the page,
				// and the next invalidate from any other action repairs it. Caught so
				// it is not an unhandled rejection, but deliberately not toasted — a
				// "couldn't save" here would be a lie about a write that succeeded.
				.catch(() => undefined)
				.finally(() => releasePending(memberId));
		} catch (e) {
			// Roll back to what the UI was actually displaying, not to `null` —
			// reverting to empty would silently erase a rung the officer did not
			// touch.
			setRungOverride((o) => ({ ...o, [memberId]: previous }));
			showWriteError(e, "Couldn't save that.");
			// Released HERE rather than in a `finally`, because the success path
			// hands the release to the invalidate above; a `finally` would release
			// a second time and drop another concurrent write's refcount.
			releasePending(memberId);
		}
	}

	// Drop a stale override once a fresh payload arrives — but drop it
	// UNCONDITIONALLY (any member with no write still in flight), not only when
	// it agrees with the server. The old effect deleted an override only
	// `if (server === value)`, which is backwards: agreement is the harmless
	// case, and an override that DISAGREES with the server — the one case that
	// matters — was pinned forever, masking every later payload for the rest of
	// the session (whole-branch review I2). `pendingWritesRef` is what keeps
	// this from evicting an override whose own write hasn't resolved yet.
	// biome-ignore lint/correctness/useExhaustiveDependencies: plan is the trigger (a fresh payload), not a value read in the body — including rungOverride would re-run on every write.
	useEffect(() => {
		setRungOverride((o) => {
			const next = { ...o };
			let changed = false;
			for (const memberId of Object.keys(o)) {
				if (pendingWritesRef.current.has(memberId)) continue;
				delete next[memberId];
				changed = true;
			}
			return changed ? next : o;
		});
	}, [effectivePlan]);

	// Advances no-answer → reached out; must NOT touch a member who already
	// answered (spec D5). Read through the override so a chip set a moment ago
	// counts.
	async function markAsked(memberId: string) {
		const current =
			rungOverride[memberId] !== undefined
				? rungOverride[memberId]
				: (effectivePlan.find((p) => p.memberId === memberId)?.status ?? null);
		if (current !== null) return;
		// Same event as the recruit picker's own `onContacted={"nudge"}` — tagging
		// it "manual" (the default) here would log the identical action under two
		// different `via` spellings in activity_log (whole-branch review M1).
		await writeRung(memberId, "reached_out", "nudge");
	}

	// The strip's own answer, read from the PUBLIC `answeredRungs` array — NEVER
	// from `plan`, which is admin-only ([] whenever `!canManage`) and would read
	// `null` forever for a plain member: they'd answer, the page would reload,
	// and the strip would ask again. A public array filtered by the client-known
	// `myId`, because the server cannot resolve "my" for an anonymous roster pick.
	const myStatus = myId
		? (answeredRungs.find((r) => r.memberId === myId)?.status ?? null)
		: null;
	// Same override the panel's chips apply, so the member's own tap is instant
	// — but clamped off `reached_out`. `rungOverride` is shared with the
	// officer panel, so an OFFICER setting their own row to `reached_out` from
	// the panel would otherwise mislabel their own strip as "can't make this
	// one — undo?", and tapping that "undo" actually DELETES the row. An
	// officer's clear is not unrestricted: since #573 `clearPlannedAttendance`
	// floors every clear server-side, and the officer arm's floor is the ASK
	// (`CLEARABLE_ASK`, `reached_out`), the self arm's and the Toastmaster's own
	// row an ANSWER (`SELF_SERVICE_RUNGS`), so neither erases the other's. On
	// another member's row the ask is the only thing an officer may clear, and
	// the Toastmaster may clear nothing. But the officer arm
	// applies to their own row too, and `reached_out` is always in its floor, so
	// the "undo" clear would erase the very outreach record the clamp exists to
	// protect (whole-branch review M8). `answeredRungs` can never itself produce
	// `reached_out` — it is filtered server-side — so this only ever intercepts
	// the override.
	let myEffectiveStatus =
		myId && rungOverride[myId] !== undefined ? rungOverride[myId] : myStatus;
	myEffectiveStatus =
		myEffectiveStatus === "reached_out" ? null : myEffectiveStatus;

	// Wraps the shared `writeRung` with the busy guard above — still ONE write
	// path (the panel's chips call `writeRung` directly), just with the strip's
	// own in-flight flag set first and cleared in `finally` so a rejected write
	// never leaves the control stuck disabled.
	async function setMyStatus(next: PlanStatus | null) {
		if (!myId) return;
		setMyStatusBusy(true);
		try {
			await writeRung(myId, next);
		} finally {
			setMyStatusBusy(false);
		}
	}

	async function confirmDecline(p: PendingDecline) {
		// Stays OPEN until the write resolves, with both controls disabled.
		// The alternative — close first, write after — is what left this
		// path with no in-flight guard at all: the dialog is modal, so
		// while it is up nothing else on the page is tappable either.
		if (declineBusy) return;
		setDeclineBusy(true);
		try {
			// `true` is passed HERE and nowhere else: this is the one call
			// site that has shown someone what would be freed.
			await commitRung(p.memberId, "not_coming", "manual", true);
		} finally {
			setDeclineBusy(false);
			setPendingDecline(null);
		}
	}

	// The agenda's recruit picker marks (#396): who has been asked, and by which
	// channel.
	async function onContacted(memberId: string, via: "nudge" | "manual") {
		try {
			await setContacted({
				data: {
					memberId,
					meetingId,
					clubId: clubUuid,
					via,
				},
			});
			await router.invalidate();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		}
	}

	async function onUncontacted(memberId: string) {
		try {
			await clearContacted({
				data: {
					memberId,
					meetingId,
					clubId: clubUuid,
				},
			});
			await router.invalidate();
		} catch (err) {
			showWriteError(err, "Something went wrong.");
		}
	}

	return {
		rungOverride,
		myEffectiveStatus,
		myStatusBusy,
		pendingDecline,
		declineBusy,
		cancelDecline: () => setPendingDecline(null),
		lineupOpen,
		setLineupOpen,
		canLineupBlast,
		writeRung,
		markAsked,
		setMyStatus,
		confirmDecline,
		onContacted,
		onUncontacted,
	};
}

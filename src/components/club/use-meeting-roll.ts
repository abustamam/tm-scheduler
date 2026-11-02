import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	releasedToastMessage,
	type useOfflineMinutes,
} from "#/hooks/use-offline-minutes";
import {
	type AttendanceMode,
	presenceWriteMode,
	withMode,
} from "#/lib/attendance-mode";
import {
	deriveRollAttendance,
	deriveRollGuests,
	deriveRollRoster,
} from "#/lib/roll-attendance";
import { welcomeBackMessage } from "#/lib/welcome-back";
import { getGuestPipeline } from "#/server/guest-pipeline";
import { type getMeetingByKey, getTmodPanelData } from "#/server/meetings";
import {
	addMinutesGuest,
	type getMinutes,
	removeMinutesGuest,
	setAttendance,
} from "#/server/minutes";
import type { AttendanceStatus } from "#/server/minutes-logic";
import type { PendingAbsent } from "./absent-release-dialog";

type MeetingDetail = Awaited<ReturnType<typeof getMeetingByKey>>;
type Held = Record<string, { name: string | null; labels: string[] }>;

/**
 * The meeting page's roll and attendance domain (#1476): recorded attendance
 * (every write rides the route's ONE `useOfflineMinutes` instance), the roll's
 * guest handlers, the Absent confirm, and the reads that build the rail's
 * roster and ladder for a viewer who is not an officer.
 *
 * `heldRolesByMember` and the offline-queue instance come in as parameters; the
 * outreach hook reads this hook's `effectivePlan` and `panelRosterForMode`, so
 * this hook is called first and never calls another `use-meeting-*` hook.
 */
export function useMeetingRoll(args: {
	meetingId: string;
	clubUuid: string;
	timezone: string;
	online: boolean;
	myId: string | null;
	effectiveCanManage: boolean;
	minutes: Awaited<ReturnType<typeof getMinutes>>;
	offlineMinutes: ReturnType<typeof useOfflineMinutes>;
	/** The contact-bearing roster the loader carries (`[]` for a non-officer). */
	loaderRoster: MeetingDetail["roster"];
	/** The roster the assign picker uses (loader or fetched), names only needed. */
	roster: { id: string; name: string }[];
	plan: MeetingDetail["plan"];
	guestRsvps: MeetingDetail["guestRsvps"];
	clubGuests: MeetingDetail["clubGuests"];
	/** The non-officer Toastmaster's extra round trip is wanted. */
	needsTmodPlan: boolean;
	panelMode: "plan" | "roll";
	showRollPanel: boolean;
	attendanceDefaultMode: AttendanceMode;
	/** Every role a member holds, numbered, keyed by member id. */
	heldRolesByMember: Held;
	/** The same roles as records (#1256), for the Absent dialog. */
	heldRoleLinesByMember: Record<string, PendingAbsent["roles"]>;
}) {
	const {
		meetingId,
		clubUuid,
		timezone,
		online,
		myId,
		effectiveCanManage,
		minutes,
		offlineMinutes,
		loaderRoster,
		roster,
		plan,
		guestRsvps,
		clubGuests,
		needsTmodPlan,
		panelMode,
		showRollPanel,
		attendanceDefaultMode,
		heldRolesByMember,
		heldRoleLinesByMember,
	} = args;
	const queryClient = useQueryClient();
	// Members already welcomed back in this view (#1446).
	const welcomedRef = useRef(new Set<string>());
	// Roll mode's Absent on a role-holder asks first (#1256). Same shape as the
	// outreach hook's decline, and for the same reason: the release has no undo.
	const [pendingAbsent, setPendingAbsent] = useState<PendingAbsent | null>(
		null,
	);
	const [absentBusy, setAbsentBusy] = useState(false);

	// Recorded rows ONLY, projected through the SAME offline queue the writes go
	// into (#176). Online this is just the loader's rows — the server stays the
	// source of truth and the chip moves on the refetch `offlineMinutes.mutate`
	// triggers. Offline no refetch will ever land, so without replaying the queue
	// an officer on dead club wifi taps "Present", nothing moves, and they tap
	// again — on the one surface #176's queue exists for. `deriveRollAttendance`
	// is the seam (`#/lib/roll-attendance`) because the route cannot mount in
	// jsdom; it also owns dropping `status: null`, which `buildRollPanel` needs
	// absent so it can render the plan's answer as a dashed suggestion.
	// `useMemo` for the same reason `meeting-minutes.tsx` uses one: `deriveMinutes`
	// structuredClones the whole snapshot.
	const rollAttendance = useMemo(
		() =>
			deriveRollAttendance({
				online,
				minutes: minutes.data,
				snapshot: offlineMinutes.snapshot,
				queue: offlineMinutes.queue,
			}),
		[online, minutes.data, offlineMinutes.snapshot, offlineMinutes.queue],
	);
	// The guests go through the SAME projection, for the same reason and one
	// control to the right (fix round 2). Raw loader rows left an offline
	// "+ Add guest" invisible AND kept the guest in the picker, since
	// `AttendanceGuestsGroup` builds its already-present filter from this very
	// list and holds no optimism of its own. Stays possibly-`undefined` — the prop
	// is optional precisely so a caller with no guests wired renders nothing
	// instead of an empty group.
	const rollGuests = useMemo(
		() =>
			deriveRollGuests({
				online,
				minutes: minutes.data,
				snapshot: offlineMinutes.snapshot,
				queue: offlineMinutes.queue,
			}),
		[online, minutes.data, offlineMinutes.snapshot, offlineMinutes.queue],
	);

	// The non-officer TMOD's ladder (#576). An officer gets it on the payload,
	// everyone else who needs it fetches it behind a server-side check.
	// `getTmodPanelData` verifies the claim against the slot and returns []
	// otherwise, so a stale `enabled` here can only under-fetch — it can never
	// hand the confidential rung to a non-TMOD.
	const tmodPlanKey = ["tmod-plan", meetingId, myId] as const;
	const {
		data: tmodPanelData,
		isPending: tmodPanelPending,
		isError: tmodPanelFailed,
	} = useQuery({
		queryKey: tmodPlanKey,
		queryFn: () =>
			getTmodPanelData({
				data: { meetingId, memberId: myId as string },
			}),
		enabled: needsTmodPlan,
	});
	// The guests the rail may EDIT (#727), and the stored fields to prefill the
	// dialog with. The payload deliberately projects `clubGuests` to
	// `{ id, name }` because guest contact has never ridden on this page, so the
	// one viewer who may fix a guest fetches it behind a gate of its own instead
	// of widening the page for everyone. `getGuestPipeline` is that gate —
	// `requireUser()` + `requireClubAdminView()` — and it is the SAME read VP
	// Membership's loader makes, so both callers of the shared dialog hand it the
	// same row type and there is no second definition of "what the dialog edits".
	//
	// `enabled` is the exact condition under which the control can appear, which
	// is BOTH conjuncts: `showRollPanel` alone says nothing about the phase, so on
	// its own it is true for an admin looking at an UPCOMING meeting — a page with
	// no Guests group on it at all — and would pull a club's visitor contact
	// details down on every pre-meeting render.
	//
	// `data` is undefined until it lands and undefined on a failure, which
	// renders the names as plain text: exactly what a viewer without the
	// capability sees. The conservative direction, and the necessary one — this
	// form turns a blank field into `null` on save, so a dialog opened over rows
	// that never arrived would wipe the record it was opened to fix.
	// ONE key, read by the fetch, by the post-save refresh and by the eviction
	// below — and `useMemo`'d so it can actually BE that one key. A fresh array
	// every render cannot go in the eviction effect's deps (the effect would tear
	// down and re-run every render, removing the query it just fetched). Written
	// out three times it is three places to get a cache key subtly wrong, and
	// every way of getting it wrong is silent: a refresh that misses leaves a
	// stale prefill, which SAVES the old value on the next submit; an eviction
	// that misses leaves a visitor's email and phone in the cache.
	const guestPipelineKey = useMemo(
		() => ["guest-pipeline", clubUuid] as const,
		[clubUuid],
	);
	const { data: guestPipeline } = useQuery({
		queryKey: guestPipelineKey,
		queryFn: () => getGuestPipeline({ data: clubUuid }),
		enabled: panelMode === "roll" && showRollPanel,
	});
	// `effectiveCanManage` and not `guestPipeline !== undefined` alone: the query
	// is the DATA, the capability is the permission, and reading the presence of
	// a fetch as a permission is exactly the shape that lets a cache entry from
	// an earlier viewer arm a control for a later one.
	//
	// The client gate is `canManage` and the server's is `requireClubRole(…,
	// ["admin"])`; both grant to a stored admin and to an elected officer holding
	// an open `officer_terms` row (effective-admin, #202).
	// `guest-edit-authz.integration.test.ts` pins that they agree.
	const guestEdit =
		effectiveCanManage && guestPipeline
			? {
					clubId: clubUuid,
					// `router.invalidate()` inside the dialog re-runs LOADERS, and these
					// rows are not loader-fetched — so without this the badge name
					// refreshed and the dialog kept prefilling the pre-edit contact
					// details, and the next save wrote them back over the edit that had
					// just landed. Required by `GuestEditCapability` for that reason.
					onSaved: () =>
						queryClient.invalidateQueries({ queryKey: guestPipelineKey }),
					fields: Object.fromEntries(
						guestPipeline.map((g) => [
							g.id,
							{
								id: g.id,
								name: g.name,
								preferredName: g.preferredName,
								email: g.email,
								// `phoneRaw`, the stored column — NEVER `g.phone`, which is
								// coalesced to E.164 for display. See `GuestEditFields`.
								phoneRaw: g.phoneRaw,
								// Not written by the form — the dialog derives "already a
								// member" from these, so its description is right on a guest
								// who joined at THIS meeting and is still on tonight's rail.
								stage: g.stage,
								convertedMembershipId: g.convertedMembershipId,
							},
						]),
					),
				}
			: undefined;
	// Evict the contact roster when the viewer changes. Keying on `myId` makes a
	// switch READ a different key; it does not remove the old one, and the default
	// gcTime keeps it in memory for five minutes. That matters on the shared club
	// laptop that gets passed around at a meeting: "not you? re-pick" would
	// otherwise leave the previous Toastmaster's copy of every member's phone and
	// email sitting in the cache (#576 review).
	// biome-ignore lint/correctness/useExhaustiveDependencies: myId is the TRIGGER, not a value the body reads — a change of viewer is exactly when the previous viewer's cached contact roster must be dropped
	useEffect(() => {
		return () => {
			queryClient.removeQueries({ queryKey: ["tmod-plan", meetingId] });
		};
	}, [queryClient, meetingId, myId]);
	// The guest pipeline gets the same treatment, in its own effect (#727),
	// because it carries every club guest's email and phone.
	//
	// What this actually buys, stated honestly: it drops the entry on UNMOUNT —
	// navigating away from the meeting, or closing the page. The `myId` trigger
	// is carried for symmetry with the eviction above and is very nearly inert
	// here, because the one viewer class that can hold this entry is a signed-in
	// admin, and the "not you? re-pick" flow that changes `myId` does not change
	// who is signed in. So the shared-laptop case is covered only to the extent
	// that the next person navigates; it is NOT the guarantee the roster eviction
	// above gives. Signing out is what clears it properly.
	//
	// A separate effect rather than a second line in the one above because that
	// statement is pinned verbatim by `attendance-panel-wiring.guard.test.ts`.
	// biome-ignore lint/correctness/useExhaustiveDependencies: myId is the TRIGGER, not a value the body reads — the same shape as the eviction above
	useEffect(() => {
		return () => {
			queryClient.removeQueries({ queryKey: guestPipelineKey });
		};
	}, [queryClient, guestPipelineKey, myId]);
	const fetchedPlan = tmodPanelData?.plan ?? [];
	// The panel needs the CONTACT-bearing roster (`loaderRoster`), not the public
	// one the assign picker falls back to — without phone and email every row
	// renders "No contact on file" and the drafts the panel exists for are gone.
	// `loaderRoster` is `[]` for a non-officer, which is why a TMOD's copy comes
	// from the same verified call as their ladder.
	const panelRoster = effectiveCanManage
		? loaderRoster
		: (tmodPanelData?.roster ?? []);
	// ROLL mode's roster is the UNION of the active roster and anyone carrying a
	// recorded attendance row for this meeting — exactly the list `loadMinutes`
	// builds and `minutes.counts` is computed over. Without it a member marked
	// present in March who left the club in April is missing from May's reopened
	// minutes: uncorrectable (the Minutes card's own recorder is gone) and, worse,
	// counted by the PDF and the emailed minutes but not by the panel, so one
	// meeting showed two different numbers. `#/lib/roll-attendance` owns it for the
	// same reason it owns the other two projections, and `buildRollPanel` is
	// deliberately untouched: it builds from whatever roster it is handed, and
	// this is what hands it one.
	const rollRoster = useMemo(
		() =>
			deriveRollRoster({
				roster: panelRoster,
				online,
				minutes: minutes.data,
				snapshot: offlineMinutes.snapshot,
				queue: offlineMinutes.queue,
			}),
		[
			panelRoster,
			online,
			minutes.data,
			offlineMinutes.snapshot,
			offlineMinutes.queue,
		],
	);
	// ONE name for the roster the panel renders, so the two modes cannot diverge
	// at the call site. PLAN mode keeps the active roster only — for an UPCOMING
	// meeting a stale row must not resurrect a departed name onto a ladder nobody
	// has answered, which is the property `roll-panel.test.ts` pins.
	const panelRosterForMode = panelMode === "roll" ? rollRoster : panelRoster;
	// A panel built from an EMPTY roster renders its header and a counts line of
	// zeros — indistinguishable from "this club has no members" and from "you are
	// no longer the Toastmaster". This page gets used mid-meeting on club wifi, so
	// a failed fetch must not produce a confident lie about who is coming (#576
	// review). Officers are unaffected: their data is on the payload, never here.
	const tmodPanelUnavailable =
		needsTmodPlan && (tmodPanelPending || tmodPanelFailed);
	// ONE name for "the ladder this viewer may see", so the panel, the optimistic
	// rollback, `markAsked` and `contactedMemberIds` cannot disagree about which
	// array they are reading — the officer path and the TMOD path differ only in
	// where the rows came from.
	const effectivePlan = effectiveCanManage ? plan : fetchedPlan;

	// Roll-mode writes. Every one goes through the route's SINGLE
	// `useOfflineMinutes` instance (#176 / DP3) rather than calling the server fn
	// directly: a direct call works online and silently vanishes offline, which
	// is precisely the condition this page is used in — a phone on club wifi,
	// mid-meeting. Reusing `offlineMinutes` rather than instantiating a second
	// hook is what keeps one `draining` flag over one persisted queue; two would
	// race it and replay a stale status over a newer one with no error.
	async function writeAttendance(memberId: string, status: AttendanceStatus) {
		// #1256: Absent on a member the page sees holding roles asks first. A member
		// holding none is written at once, as before. Like the decline's confirm,
		// the page cannot see a slot claimed since it loaded, so the list is what
		// the page KNOWS; the release itself frees whatever the member holds when
		// the write runs.
		const held = heldRolesByMember[memberId];
		if (status === "absent" && held && held.labels.length > 0) {
			setPendingAbsent({
				memberId,
				name:
					held.name ??
					panelRosterForMode.find((r) => r.id === memberId)?.name ??
					"this member",
				roles: heldRoleLinesByMember[memberId] ?? [],
			});
			return;
		}
		// #1049: which mode, if any, rides this write — `presenceWriteMode` says
		// why. Read against the PROJECTED rows, so an offline tap sees the status
		// the officer is looking at, not the stale loader's.
		const mode = presenceWriteMode({
			status,
			currentStatus: rollAttendance.find((a) => a.memberId === memberId)
				?.status,
			defaultMode: attendanceDefaultMode,
		});
		await writePresence(memberId, status, mode);
	}

	// The toggle on a present row (#1049). Same op, same server fn: a present
	// write WITH a mode, which the server upserts.
	async function writeAttendanceMode(memberId: string, mode: AttendanceMode) {
		await writePresence(memberId, "present", mode);
	}

	async function writePresence(
		memberId: string,
		status: AttendanceStatus,
		mode: AttendanceMode | undefined,
		/** Only the Absent dialog's "Release roles" passes these (#1256): the slot
		 *  ids it LISTED, which are the most the write may free. */
		releaseSlotIds?: string[],
		name?: string,
	) {
		const release =
			releaseSlotIds && releaseSlotIds.length > 0
				? ({ releaseHeldRoles: true, releaseSlotIds } as const)
				: {};
		await offlineMinutes.mutate(
			async () => {
				const result = await setAttendance({
					data: {
						meetingId,
						memberId,
						status,
						...withMode(mode),
						...release,
					},
				});
				// The receipt for an ONLINE release: what the server actually freed,
				// never what the dialog listed. Nothing when it freed nothing. The
				// agenda refresh is the write's own `onMutated` (router.invalidate).
				if (result.released.length > 0) {
					toast.success(
						releasedToastMessage(
							name ?? "this member",
							result.released.map((r) => r.label),
						),
					);
				}
				// #1446: officer-only, nothing stored. Once per member per view:
				// re-marking Present (or the mode toggle) must not toast twice.
				if (result.welcomeBack && !welcomedRef.current.has(memberId)) {
					welcomedRef.current.add(memberId);
					const who =
						name ?? roster?.find((r) => r.id === memberId)?.name ?? "";
					toast.success(
						welcomeBackMessage(
							who,
							result.welcomeBack.lastPresentAt,
							new Date(),
							timezone,
						),
					);
				}
				return result;
			},
			() => ({
				type: "setAttendance",
				...offlineMinutes.opMeta(),
				memberId,
				status,
				...withMode(mode),
				...release,
			}),
		);
	}

	async function confirmAbsent(p: PendingAbsent, releaseHeldRoles: boolean) {
		// Stays open until the write resolves, both controls disabled, like the
		// decline's confirm. The mode rides as `writeAttendance` computes it.
		if (absentBusy) return;
		setAbsentBusy(true);
		try {
			await writePresence(
				p.memberId,
				"absent",
				presenceWriteMode({
					status: "absent",
					currentStatus: rollAttendance.find((a) => a.memberId === p.memberId)
						?.status,
					defaultMode: attendanceDefaultMode,
				}),
				releaseHeldRoles ? p.roles.map((r) => r.slotId) : undefined,
				p.name,
			);
		} finally {
			setAbsentBusy(false);
			setPendingAbsent(null);
		}
	}

	// The two guest handlers are lifted from <MeetingMinutes>'s AttendanceSection
	// wiring (meeting-minutes.tsx) — same bodies, not new ones. The
	// `crypto.randomUUID()` client-side guest PK is load-bearing: it is what makes
	// a queued new-guest op replay idempotently instead of creating a second guest
	// row on reconnect (#176 slice 5). `name` is resolved here because the queued
	// op has to render an optimistic row offline, with no round trip to name it.
	const guestName = (guestId: string) =>
		guestRsvps.find((g) => g.guestId === guestId)?.name ??
		clubGuests.find((g) => g.id === guestId)?.name ??
		"Guest";

	async function addRollGuest(payload: {
		guestId?: string;
		newGuest?: { name: string; email?: string; phone?: string };
	}) {
		// #1049: adding a guest IS recording them present, so it carries the
		// mode the toggle starts on — the same rule as a member's first Present.
		// Insert-only on the server: a guest ALREADY present (re-picked, or a
		// re-typed returning visitor the server dedupes) keeps their mode.
		const mode = attendanceDefaultMode;
		await offlineMinutes.mutate(
			() => addMinutesGuest({ data: { meetingId, ...payload, mode } }),
			() =>
				payload.newGuest
					? {
							type: "addGuest",
							...offlineMinutes.opMeta(),
							guestId: crypto.randomUUID(),
							name: payload.newGuest.name,
							newGuest: payload.newGuest,
							mode,
						}
					: {
							type: "addGuest",
							...offlineMinutes.opMeta(),
							guestId: payload.guestId as string,
							name: guestName(payload.guestId as string),
							mode,
						},
		);
	}

	// A guest's in person / online toggle (#1049). An `addGuest` with a mode AND
	// `replaceMode` (the only add that may change an existing row's mode),
	// which the server upserts onto the row — and, for a guest listed only
	// because they hold a role, creates it (maintainer's decision 3). The name
	// comes off the listed row first: a role-only guest need not be in
	// `clubGuests`' picker list under the same name.
	async function setRollGuestMode(guestId: string, mode: AttendanceMode) {
		const name =
			rollGuests?.find((g) => g.guestId === guestId)?.name ??
			guestName(guestId);
		await offlineMinutes.mutate(
			() =>
				addMinutesGuest({
					data: { meetingId, guestId, mode, replaceMode: true },
				}),
			() => ({
				type: "addGuest",
				...offlineMinutes.opMeta(),
				guestId,
				name,
				mode,
				replaceMode: true,
			}),
		);
	}

	async function removeRollGuest(guestId: string) {
		await offlineMinutes.mutate(
			() => removeMinutesGuest({ data: { meetingId, guestId } }),
			() => ({ type: "removeGuest", ...offlineMinutes.opMeta(), guestId }),
		);
	}

	return {
		rollAttendance,
		rollGuests,
		tmodPlanKey,
		effectivePlan,
		panelRosterForMode,
		tmodPanelUnavailable,
		guestEdit,
		pendingAbsent,
		absentBusy,
		cancelAbsent: () => setPendingAbsent(null),
		writeAttendance,
		writeAttendanceMode,
		writePresence,
		confirmAbsent,
		addRollGuest,
		setRollGuestMode,
		removeRollGuest,
	};
}

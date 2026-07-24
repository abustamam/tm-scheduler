# Unify the two meeting views into one canonical page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/club/:clubId/meeting/:key` the single canonical meeting page for every audience (anon, signed-in member, admin) and turn the old `/meetings/:id` route into a redirect to it.

**Architecture:** The pretty route already loads session-aware for shell members (`getMeetingByKey`) and PII-safe for anon (`getPublicMeetingByKey`), and both routes already render the shared `<MeetingAgenda>` off a `meetingViewer(...)` capability object. The only reason the pretty route isn't already the management view is that it hardcodes `canManage: false` and omits the management sections. We (1) extract the two routes' viewer-resolution asymmetry into one pure, unit-tested `resolveMeetingViewer`, (2) expand the pretty route's component to render every section gated on capability, (3) collapse `/meetings/:id` to a redirect, and (4) fix the two path-coupled consumers (service worker offline matcher, app-shell breadcrumb) plus repoint `/next`.

**Tech Stack:** TanStack Start (React 19, SSR/Nitro), TanStack Router loaders + `redirect()`/`notFound()`, Drizzle/pg server fns via `createServerFn`, Vitest, Biome (tabs, double quotes), TypeScript strict. Package manager: Bun.

---

## Two deliberate deviations from the approved design spec (flagged for review)

The approved design (`docs/superpowers/specs/2026-07-22-unify-meeting-views-design.md`) is followed in **behavior**. Two structural choices differ; both are documented here so they can be vetoed at plan review:

1. **Inline, not a separate `<MeetingDetailPage>` component.** The spec proposed extracting a shared component. But once `/meetings/:id` becomes a redirect (Task 3), there is exactly **one** route that renders a meeting — the value of a *shared* component is gone, and extraction would force drilling ~25 loader fields (or an opaque data blob) into a child. The codebase's established pattern is an inline route component (both current routes do this). So we expand the pretty route's `MeetingView` in place. Observable behavior is identical.

2. **No standalone "actions-selection" unit test.** The spec called for one, on the premise that the manager action path omits `selfMemberId` while the self-serve path carries it. On inspection that premise doesn't hold: **both** current routes pass `selfMemberId` on `addSpeaker`/`removeSpeaker` and **neither** passes it on `claim`/`release`/`takeover`. The only real manager-vs-self difference is that the manager object also exposes `confirm`/`unconfirm`/`moveSpeaker`/`removeRole` — and whether those controls render is gated by `viewer.canManage`, which **is** unit-tested (Task 1) and enforced server-side by existing slot-fn authz tests. A separate actions test would be redundant, so it is dropped.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/meeting-lifecycle.ts` | Modify | Add pure `resolveMeetingViewer(...)` — the one place the manager-vs-member editing-window asymmetry lives. |
| `src/lib/meeting-lifecycle.test.ts` | Modify | Unit-test the `resolveMeetingViewer` branch table. |
| `src/routes/club.$clubId.meeting.$meetingId.tsx` | Rewrite component + extend loader | The unified canonical meeting page for all three audiences. |
| `src/routes/_authed/meetings.$id.tsx` | Rewrite → redirect stub | Resolve slug+key, `redirect()` to the pretty URL; `notFound()` on unknown id. |
| `public/sw.js` | Modify | Extend offline nav matcher to the pretty meeting path; bump cache VERSION. |
| `src/components/app-shell.tsx` | Modify | Add a breadcrumb branch for `/club/…/meeting/…`. |
| `src/routes/_authed/next.tsx` | Modify | Redirect straight to the pretty URL (avoids a double hop). |
| `src/routes/public-meeting-contact.guard.test.ts` | Modify | Assert the loader gates `getMinutes` behind `context.shell` (anon never loads minutes). |

---

## Task 1: Pure `resolveMeetingViewer` (viewer-resolution asymmetry)

**Files:**
- Modify: `src/lib/meeting-lifecycle.ts`
- Test: `src/lib/meeting-lifecycle.test.ts`

**Why:** Today the two routes compute the viewer with subtly different edit-window logic (admin edits a past-but-open meeting until Complete; member/anon freezes once the date passes). Extracting this into one pure function is the seam that lets one component serve all audiences, and it is the highest-value unit test in this change.

- [ ] **Step 1: Write the failing test**

Append this block to `src/lib/meeting-lifecycle.test.ts` (and add `resolveMeetingViewer` to the existing import from `./meeting-lifecycle`):

```ts
describe("resolveMeetingViewer", () => {
	const tz = "America/New_York";
	const now = new Date("2026-07-10T12:00:00Z");
	const future = "2026-07-15T18:00:00Z";
	const past = "2026-07-05T18:00:00Z";
	const common = {
		timezone: tz,
		currentMemberId: "m1" as string | null,
		isTmod: false,
		isGrammarian: false,
		now,
	};

	it("admin on a future meeting: full management, editable meta", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: future,
			canManage: true,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
	});

	it("admin keeps editing a past-but-open meeting (not locked-wrapped)", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: past,
			canManage: true,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(true);
		expect(v.canAssign).toBe(true);
		expect(v.canEditMeetingMeta).toBe(true);
	});

	it("admin on a completed (locked) meeting is read-only", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "completed",
			scheduledAt: past,
			canManage: true,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(false);
		expect(v.canAssign).toBe(false);
		expect(v.canClaim).toBe(false);
	});

	it("signed-in member on a future meeting can claim + take over", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: future,
			canManage: false,
			isSignedIn: true,
		});
		expect(v.canManage).toBe(false);
		expect(v.canClaim).toBe(true);
		expect(v.canTakeOver).toBe(true);
		expect(v.canToggleAvailability).toBe(true);
	});

	it("member on a past meeting freezes read-only (over)", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: past,
			canManage: false,
			isSignedIn: true,
		});
		expect(v.canClaim).toBe(false);
		expect(v.canToggleAvailability).toBe(false);
	});

	it("anon on a future meeting can claim but not take over", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: future,
			canManage: false,
			isSignedIn: false,
		});
		expect(v.canClaim).toBe(true);
		expect(v.canTakeOver).toBe(false);
	});

	it("anon on a past meeting freezes read-only", () => {
		const v = resolveMeetingViewer({
			...common,
			status: "scheduled",
			scheduledAt: past,
			canManage: false,
			isSignedIn: false,
		});
		expect(v.canClaim).toBe(false);
	});
});
```

The existing import line at the top of the file becomes:

```ts
import {
	isMeetingLocked,
	lockedViewer,
	meetingDatePassed,
	meetingDateReached,
	resolveMeetingViewer,
} from "./meeting-lifecycle";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bunx vitest run src/lib/meeting-lifecycle.test.ts`
Expected: FAIL — `resolveMeetingViewer is not a function` / import has no exported member `resolveMeetingViewer`.

- [ ] **Step 3: Implement `resolveMeetingViewer`**

In `src/lib/meeting-lifecycle.ts`, change the top import to pull in the `meetingViewer` **value** (not just the type):

```ts
import { utcToZonedWallTime } from "./datetime";
import { type MeetingViewer, meetingViewer } from "./meeting-viewer";
```

Then append this function to the end of the file (after `lockedViewer`):

```ts
/**
 * Resolve the single viewer both meeting audiences share (#317). Encodes the one
 * asymmetry between the manager and self-serve paths: an admin keeps editing a
 * past-but-open meeting until they Complete it, while a member/anon agenda
 * freezes once the meeting date passes. A completed (locked) meeting is
 * read-only for everyone. Pure + injectable `now` so it is deterministically
 * testable. Both `<MeetingAgenda>` surfaces build their viewer through this.
 */
export function resolveMeetingViewer(input: {
	status: string;
	scheduledAt: Date | string;
	timezone: string;
	currentMemberId: string | null;
	canManage: boolean;
	isTmod: boolean;
	isGrammarian: boolean;
	isSignedIn: boolean;
	now?: Date;
}): MeetingViewer {
	const locked = isMeetingLocked(input.status);
	const over =
		locked || meetingDatePassed(input.scheduledAt, input.timezone, input.now);
	// Managers edit until Complete (locked); members/anon freeze once `over`.
	const editable = input.canManage ? !locked : !over;
	const base = meetingViewer({
		currentMemberId: input.currentMemberId,
		canManage: input.canManage,
		isTmod: input.isTmod,
		isGrammarian: input.isGrammarian,
		isEditableWindow: editable,
		isSignedIn: input.isSignedIn,
	});
	return (input.canManage ? locked : over) ? lockedViewer(base) : base;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bunx vitest run src/lib/meeting-lifecycle.test.ts`
Expected: PASS — all `resolveMeetingViewer` cases plus the pre-existing lifecycle tests green.

- [ ] **Step 5: Typecheck**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bun run typecheck`
Expected: no errors (this is the only thing that type-checks; build/test transpile without it).

- [ ] **Step 6: Commit**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views
git add src/lib/meeting-lifecycle.ts src/lib/meeting-lifecycle.test.ts
git commit -m "$(cat <<'EOF'
feat(meeting): pure resolveMeetingViewer unifying edit-window logic

Extracts the manager-vs-member editing-window asymmetry (admin edits a
past-but-open meeting until Complete; member/anon freezes once the date
passes; locked → read-only for all) into one injectable, unit-tested
function so a single component can serve every meeting audience (#317).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AoR3mA2qL9gma7xzmzQve1
EOF
)"
```

---

## Task 2: Unify the canonical meeting page

**Files:**
- Rewrite: `src/routes/club.$clubId.meeting.$meetingId.tsx`

**Why:** This is the composition step — the pretty route becomes the one page for anon, signed-in member, and admin. The loader keeps the PII fork verbatim and additionally loads minutes for shell members; the component renders every section gated on capability, using `resolveMeetingViewer` for the viewer and picking a manager-vs-self `actions` object by `effectiveCanManage`.

**Design contract enforced by this file:**
- The `context.shell ? getMeetingByKey : getPublicMeetingByKey` fork is **verbatim** (PII boundary; `public-meeting-contact.guard.test.ts` asserts it).
- `getMinutes` is reached **only** on the `context.shell` branch — anon payloads never load minutes.
- Manager sections (Minutes edit, Role sheets, Add role, Complete/Reopen, Preview-as-member, "not available" names, contacted tracker, holder-contact nudges) render only when `effectiveCanManage`.
- Container widens to `max-w-workspace` when the real `canManage` is true, else `max-w-reading`.

- [ ] **Step 1: Replace the entire file with the unified version**

Overwrite `src/routes/club.$clubId.meeting.$meetingId.tsx` with:

```tsx
import { useQuery } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	notFound,
	useRouter,
} from "@tanstack/react-router";
import {
	CalendarDays,
	CheckCircle2,
	Clock,
	Eye,
	Loader2,
	Lock,
	LockOpen,
	MapPin,
	Sparkles,
	WifiOff,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
	MeetingAgenda,
	type MeetingAgendaActions,
} from "#/components/agenda/meeting-agenda";
import { MeetingAnnouncements } from "#/components/agenda/meeting-announcements";
import { GuestResources } from "#/components/club/guest-resources";
import { useRequireIdentity } from "#/components/club/identity-gate";
import { MeetingMinutes } from "#/components/club/meeting-minutes";
import { MeetingNavStrip } from "#/components/club/meeting-nav-strip";
import { MeetingRoleSheets } from "#/components/club/meeting-role-sheets";
import { MeetingViewActions } from "#/components/club/meeting-view-actions";
import { ViewingAs } from "#/components/club/viewing-as";
import { ShareLinkButton } from "#/components/share-link-button";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Label } from "#/components/ui/label";
import { useOnlineStatus } from "#/hooks/use-online-status";
import { applyFlex, expandRunSheet } from "#/lib/agenda-runsheet";
import { buildSlideDeck } from "#/lib/agenda-slides";
import {
	formatMeetingDate,
	formatMeetingTime,
	formatMeetingTimeRange,
} from "#/lib/format";
import { isMeetingNotFoundError } from "#/lib/meeting-errors";
import {
	isMeetingLocked,
	MEETING_LOCKED_MESSAGE,
	meetingDatePassed,
	meetingDateReached,
	resolveMeetingViewer,
} from "#/lib/meeting-lifecycle";
import { deriveMeetingNavItems } from "#/lib/meeting-nav";
import { deriveMeetingRoleFlags, pairedRoleIds } from "#/lib/meeting-roles";
import { useEffectiveMember } from "#/lib/member-identity";
import { footerDate } from "#/lib/slide-layout";
import { clearAvailability, setAvailability } from "#/server/availability";
import {
	completeMeeting,
	getMeetingByKey,
	getPublicMeetingByKey,
	listUpcomingMeetings,
	reopenMeeting,
} from "#/server/meetings";
import { listMembers } from "#/server/members";
import { getMinutes } from "#/server/minutes";
import { getMinutesRecipients } from "#/server/minutes-email";
import { clearContacted, setContacted } from "#/server/outreach";
import {
	addRoleSlot,
	addSpeakerSlot,
	claimSlot,
	confirmSlot,
	moveSpeakerSlot,
	reassignSlot,
	releaseSlot,
	removeRoleSlot,
	removeSpeakerSlot,
	unconfirmSlot,
} from "#/server/slots";

// Anonymous (non-shell) visitors never load minutes — this hidden default keeps
// the loader's return shape uniform without a server call or any PII fetch.
const EMPTY_MINUTES = {
	visible: false,
	canEdit: false,
	data: null,
	program: [],
} as Awaited<ReturnType<typeof getMinutes>>;

export const Route = createFileRoute("/club/$clubId/meeting/$meetingId")({
	loader: async ({ params, context }) => {
		// PII boundary (#37): a signed-in member of this club (shell) loads the
		// session-aware getMeetingByKey — an admin regains management + contact; a
		// non-admin member gets canManage=false. An anonymous visitor loads
		// getPublicMeetingByKey (hard canManage=false, never any PII). Both resolve
		// the $meetingId key identically, so the loader shape matches either way
		// (#317). KEEP THIS FORK VERBATIM — public-meeting-contact.guard.test.ts
		// asserts it.
		const load = context.shell ? getMeetingByKey : getPublicMeetingByKey;
		const meetingPromise = load({
			data: { clubId: context.clubUuid, key: params.meetingId },
		}).catch((err) => {
			if (isMeetingNotFoundError(err)) throw notFound();
			throw err;
		});
		const upcomingPromise = listUpcomingMeetings({
			data: context.clubUuid,
		}).catch(() => [] as Awaited<ReturnType<typeof listUpcomingMeetings>>);

		const data = await meetingPromise;
		// Guard against a meetingId that belongs to a different club than the URL.
		if (data.meeting.clubId !== context.clubUuid) throw notFound();

		const upcoming = await upcomingPromise;
		const navItems = deriveMeetingNavItems(
			data.meeting,
			data.slots,
			upcoming,
			data.timezone,
		);

		// Minutes (ADR-0014 / #152) — ONLY for a signed-in member (shell); an anon
		// visitor never reaches getMinutes. Non-fatal: degrade to hidden. Keyed by
		// the resolved uuid (params.meetingId is the pretty key). The PII guard test
		// asserts this shell gate stays.
		const minutes = context.shell
			? await getMinutes({ data: data.meeting.id }).catch(() => EMPTY_MINUTES)
			: EMPTY_MINUTES;
		// Default email recipients (#165) — admins on a completed meeting only.
		const minutesEmail =
			context.shell &&
			minutes.visible &&
			minutes.canEdit &&
			isMeetingLocked(data.meeting.status)
				? await getMinutesRecipients({
						data: { clubId: data.meeting.clubId, meetingId: data.meeting.id },
					}).catch(() => null)
				: null;

		return { ...data, navItems, minutes, minutesEmail };
	},
	component: MeetingView,
	notFoundComponent: MeetingNotFound,
});

function MeetingNotFound() {
	const { clubId } = Route.useParams();
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
			<p className="font-semibold text-lg">Meeting not found</p>
			<p className="text-muted-foreground text-sm">
				This meeting doesn't exist for this club, or the link is out of date.
			</p>
			<Button asChild variant="outline">
				<Link
					to="/club/$clubId"
					params={{ clubId }}
					search={{ view: "roles", count: 8 }}
				>
					Back to meetings
				</Link>
			</Button>
		</div>
	);
}

function errMessage(err: unknown) {
	return err instanceof Error ? err.message : "Something went wrong.";
}

function MeetingView() {
	const { clubId } = Route.useParams();
	const { clubUuid, effectiveMemberId, authCtx, shell } =
		Route.useRouteContext();
	const {
		meeting,
		slots,
		canManage,
		timezone,
		unavailableMembers,
		unavailableMemberIds,
		roleRecency,
		navItems,
		clubName,
		clubNumber,
		clubDistrict,
		clubMeetingSchedule,
		clubRoles,
		clubGuests,
		roster: loaderRoster,
		contactedMemberIds,
		minutes,
		minutesEmail,
		nextMeetingAt,
		urlKey,
	} = Route.useLoaderData();
	const router = useRouter();
	const online = useOnlineStatus();

	// Shell-wrapped signed-in member → act as the session identity; anonymous
	// visitor → the localStorage-picked member (#317).
	const session =
		effectiveMemberId && authCtx?.user
			? { id: effectiveMemberId, name: authCtx.user.name || authCtx.user.email }
			: null;
	const { member, source } = useEffectiveMember(clubId, session);
	const { requireIdentity, promptIdentity } = useRequireIdentity();
	const myId = member?.id ?? null;
	const isSignedIn = session !== null;
	// The session member drives the manager action path (matches the old
	// /meetings/:id route's `currentMemberId`); null for an impersonating
	// superadmin (canManage without a linked member).
	const managerActorId = session?.id ?? null;

	const [availBusy, setAvailBusy] = useState(false);
	const [addRoleOpen, setAddRoleOpen] = useState(false);
	const [addRoleBusy, setAddRoleBusy] = useState(false);
	const [lifecycleBusy, setLifecycleBusy] = useState(false);
	// #320: an admin can preview the page as a non-admin member sees it.
	const [previewAsMember, setPreviewAsMember] = useState(false);

	const flex = applyFlex(expandRunSheet(slots), meeting.lengthMinutes);
	const projectedEnd = new Date(
		new Date(meeting.scheduledAt).getTime() + flex.projectedMinutes * 60_000,
	);
	const deck = buildSlideDeck(
		meeting,
		{
			name: clubName,
			clubNumber,
			district: clubDistrict,
			timezone,
			meetingSchedule: clubMeetingSchedule,
		},
		slots,
		nextMeetingAt,
	);

	const { isTmod, isGrammarian } = deriveMeetingRoleFlags(slots, myId);
	const locked = isMeetingLocked(meeting.status);
	const datePassed = meetingDatePassed(meeting.scheduledAt, timezone);
	const over = locked || datePassed;
	// #320: previewing-as-member drops management everywhere it gates admin UI.
	const effectiveCanManage = canManage && !previewAsMember;
	const canComplete = meetingDateReached(meeting.scheduledAt, timezone);

	// One viewer for all audiences: an admin keeps editing a past-but-open meeting
	// until Complete; a member/anon agenda freezes once the date passes; a locked
	// meeting is read-only for everyone. (Pure — unit-tested in Task 1.)
	const viewer = resolveMeetingViewer({
		status: meeting.status,
		scheduledAt: meeting.scheduledAt,
		timezone,
		currentMemberId: myId,
		canManage: effectiveCanManage,
		isTmod,
		isGrammarian,
		isSignedIn,
	});

	// Roster for the assign picker: a manager already has it (with contact) from
	// the loader; a non-admin TMOD (public or signed-in) fetches the plain member
	// list client-side, since the public payload carries no roster.
	const { data: fetchedRoster = [] } = useQuery({
		queryKey: ["members", clubUuid],
		queryFn: () => listMembers({ data: clubUuid }),
		enabled: !canManage && isTmod,
	});
	const roster = canManage ? loaderRoster : fetchedRoster;

	const pairedIds = pairedRoleIds(clubRoles);
	const addableRoles = clubRoles.filter((r) => !pairedIds.has(r.id));
	const nudgeShareUrl =
		typeof window === "undefined"
			? `/club/${clubId}/meeting/${urlKey}`
			: `${window.location.origin}/club/${clubId}/meeting/${urlKey}`;
	const nudgeDate = footerDate(meeting.scheduledAt, timezone);
	const myUnavailable = myId ? unavailableMemberIds.includes(myId) : false;
	// The agenda's internal claim/assign acts as this member: the session member
	// for a manager (null for an impersonator), the effective member otherwise.
	const agendaMemberId = effectiveCanManage ? managerActorId : myId;
	const containerClass = canManage
		? "max-w-workspace px-4 pt-5 pb-10 sm:px-7 sm:pt-7 space-y-5"
		: "mx-auto w-full max-w-reading p-4 pb-8 md:p-6 space-y-5";

	async function toggleAvailability() {
		setAvailBusy(true);
		try {
			const me = await requireIdentity();
			if (!me) return;
			if (myUnavailable) {
				await clearAvailability({
					data: { memberId: me.id, meetingId: meeting.id, clubId: clubUuid },
				});
				toast.success("You're marked as available again.");
			} else {
				await setAvailability({
					data: { memberId: me.id, meetingId: meeting.id, clubId: clubUuid },
				});
				toast.success("Got it — you can't make this one.");
			}
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setAvailBusy(false);
		}
	}

	// Manager (admin) actions: act as the session member; exposes the manager-only
	// confirm/unconfirm/moveSpeaker/removeRole set.
	const managerActions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
			if (!managerActorId) {
				throw new Error("Your account isn't linked to a club member yet.");
			}
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: managerActorId,
					actorMemberId: managerActorId,
					speakerDetails,
				},
			});
		},
		release: async (slot) => {
			await releaseSlot({
				data: { slotId: slot.id, actorMemberId: managerActorId },
			});
		},
		takeover: async (slot) => {
			if (!managerActorId) {
				throw new Error("Your account isn't linked to a club member yet.");
			}
			await reassignSlot({
				data: {
					slotId: slot.id,
					memberId: managerActorId,
					actorMemberId: managerActorId,
				},
			});
		},
		confirm: async (slot) => {
			await confirmSlot({
				data: { slotId: slot.id, actorMemberId: managerActorId },
			});
		},
		unconfirm: async (slot) => {
			await unconfirmSlot({
				data: { slotId: slot.id, actorMemberId: managerActorId },
			});
		},
		moveSpeaker: async (slot, direction) => {
			await moveSpeakerSlot({
				data: { slotId: slot.id, direction, actorMemberId: managerActorId },
			});
		},
		removeRole: async (slot) => {
			await removeRoleSlot({
				data: { slotId: slot.id, actorMemberId: managerActorId },
			});
		},
		addSpeaker: async () => {
			await addSpeakerSlot({
				data: {
					meetingId: meeting.id,
					actorMemberId: managerActorId,
					selfMemberId: managerActorId,
				},
			});
		},
		removeSpeaker: async () => {
			await removeSpeakerSlot({
				data: {
					meetingId: meeting.id,
					actorMemberId: managerActorId,
					selfMemberId: managerActorId,
				},
			});
		},
		onMutated: () => router.invalidate(),
	};

	// Self-serve (member / anon) actions: resolve identity first (a signed-in
	// member resolves without a prompt; an anon visitor identifies at click) and
	// carry `selfMemberId`, so the server takes the ADR-0010 self-serve path.
	const selfActions: MeetingAgendaActions = {
		claim: async (slot, speakerDetails) => {
			const me = await requireIdentity();
			if (!me) return;
			await claimSlot({
				data: {
					slotId: slot.id,
					memberId: me.id,
					actorMemberId: me.id,
					speakerDetails,
				},
			});
		},
		release: async (slot) => {
			const me = await requireIdentity();
			if (!me) return;
			await releaseSlot({ data: { slotId: slot.id, actorMemberId: me.id } });
		},
		takeover: async (slot) => {
			const me = await requireIdentity();
			if (!me) return;
			await reassignSlot({
				data: { slotId: slot.id, memberId: me.id, actorMemberId: me.id },
			});
		},
		addSpeaker: async () => {
			const me = await requireIdentity();
			if (!me) return;
			await addSpeakerSlot({
				data: { meetingId: meeting.id, actorMemberId: me.id, selfMemberId: me.id },
			});
			toast.success("Speaker added.");
		},
		removeSpeaker: async () => {
			const me = await requireIdentity();
			if (!me) return;
			await removeSpeakerSlot({
				data: { meetingId: meeting.id, actorMemberId: me.id, selfMemberId: me.id },
			});
			toast.success("Speaker removed.");
		},
		onMutated: () => router.invalidate(),
	};

	const actions = effectiveCanManage ? managerActions : selfActions;

	async function doAddRole(roleDefinitionId: string) {
		setAddRoleBusy(true);
		try {
			await addRoleSlot({
				data: {
					meetingId: meeting.id,
					roleDefinitionId,
					actorMemberId: managerActorId,
				},
			});
			toast.success("Role added.");
			setAddRoleOpen(false);
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setAddRoleBusy(false);
		}
	}

	async function doComplete() {
		setLifecycleBusy(true);
		try {
			await completeMeeting({
				data: { meetingId: meeting.id, actorMemberId: managerActorId },
			});
			toast.success("Meeting closed out and locked.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setLifecycleBusy(false);
		}
	}

	async function doReopen() {
		setLifecycleBusy(true);
		try {
			await reopenMeeting({
				data: { meetingId: meeting.id, actorMemberId: managerActorId },
			});
			toast.success("Meeting reopened for edits.");
			await router.invalidate();
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setLifecycleBusy(false);
		}
	}

	return (
		<div className={containerClass}>
			{previewAsMember ? (
				<div className="flex items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3 text-sm font-medium text-primary">
					<span className="flex items-center gap-2">
						<Eye className="size-4 shrink-0" aria-hidden />
						Previewing as a member — management controls are hidden.
					</span>
					<Button
						size="sm"
						variant="outline"
						onClick={() => setPreviewAsMember(false)}
					>
						Exit preview
					</Button>
				</div>
			) : null}
			{!online && shell ? (
				<div className="flex items-center gap-2 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm font-medium text-warning-foreground">
					<WifiOff className="size-4 shrink-0" aria-hidden />
					You're offline — minutes edits are saved on this device and sync when
					you reconnect. Other changes (meeting details, roles) need a
					connection.
				</div>
			) : null}
			{locked ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-medium text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					{MEETING_LOCKED_MESSAGE}
				</div>
			) : datePassed && !effectiveCanManage ? (
				<div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm font-medium text-muted-foreground">
					<Lock className="size-4" aria-hidden />
					This meeting has already taken place.
				</div>
			) : null}
			<header className="space-y-2 pt-2">
				<h1 className="font-display text-2xl font-semibold tracking-tight">
					{meeting.theme ?? "Meeting"}
				</h1>
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
					<span className="flex items-center gap-1.5">
						<CalendarDays className="size-4" aria-hidden />
						{formatMeetingDate(meeting.scheduledAt, timezone)} ·{" "}
						{formatMeetingTimeRange(
							meeting.scheduledAt,
							meeting.lengthMinutes,
							timezone,
						)}
					</span>
					{flex.status !== "exact" ? (
						<span
							className={
								flex.status === "over"
									? "flex items-center gap-1.5 font-medium text-destructive"
									: "flex items-center gap-1.5 text-muted-foreground"
							}
						>
							<Clock className="size-4" aria-hidden />
							{flex.status === "over"
								? `Projected end ${formatMeetingTime(projectedEnd, timezone)} · runs ${flex.deltaMinutes} min long`
								: `Projected end ${formatMeetingTime(projectedEnd, timezone)} · ends ${-flex.deltaMinutes} min early`}
						</span>
					) : null}
					{meeting.location ? (
						<span className="flex items-center gap-1.5">
							<MapPin className="size-4" aria-hidden />
							{meeting.location}
						</span>
					) : null}
				</div>
				<MeetingNavStrip clubId={clubId} items={navItems} />
				{meeting.wordOfTheDay ? (
					<p className="flex items-center gap-1.5 text-sm">
						<Sparkles className="size-4 text-primary" aria-hidden />
						<span className="text-muted-foreground">Word of the day:</span>
						<span className="font-medium">{meeting.wordOfTheDay}</span>
					</p>
				) : null}
				{source === "anon" ? (
					<ViewingAs member={member} promptIdentity={promptIdentity} />
				) : null}
				{over ? (
					myId ? (
						<p className="mt-1 text-sm font-medium text-muted-foreground">
							{myUnavailable
								? "You did not attend this meeting."
								: "You attended this meeting."}
						</p>
					) : null
				) : (
					<Button
						type="button"
						variant={myUnavailable ? "default" : "outline"}
						size="sm"
						onClick={toggleAvailability}
						disabled={!viewer.canToggleAvailability || availBusy}
						className="mt-1"
					>
						{availBusy ? (
							<Loader2 className="size-4 animate-spin" />
						) : myUnavailable ? (
							"You can't make this one — undo?"
						) : (
							"I can't make this one"
						)}
					</Button>
				)}
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<ShareLinkButton
						path={`/club/${clubId}/meeting/${urlKey}`}
						label={canManage ? "Copy member link" : undefined}
					/>
					<MeetingViewActions
						clubSlug={clubId}
						meetingId={urlKey}
						deck={deck}
						clubName={clubName}
					/>
					{effectiveCanManage ? (
						<MeetingRoleSheets meetingId={meeting.id} />
					) : null}
					{effectiveCanManage && !locked && addableRoles.length > 0 ? (
						<Button
							size="sm"
							variant="outline"
							onClick={() => setAddRoleOpen(true)}
						>
							+ Add role
						</Button>
					) : null}
					{effectiveCanManage && locked ? (
						<Button
							size="sm"
							variant="outline"
							onClick={doReopen}
							disabled={lifecycleBusy}
						>
							{lifecycleBusy ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<LockOpen className="size-4" />
							)}
							Reopen meeting
						</Button>
					) : null}
					{effectiveCanManage && !locked && canComplete ? (
						<Button size="sm" onClick={doComplete} disabled={lifecycleBusy}>
							{lifecycleBusy ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<CheckCircle2 className="size-4" />
							)}
							Complete meeting
						</Button>
					) : null}
					{canManage && !previewAsMember ? (
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setPreviewAsMember(true)}
						>
							<Eye className="size-4" />
							Preview as member
						</Button>
					) : null}
				</div>
			</header>

			<MeetingAnnouncements text={meeting.reminders} />

			{effectiveCanManage ? null : <GuestResources />}

			<MeetingAgenda
				slots={slots}
				viewer={viewer}
				actions={actions}
				roster={roster}
				roleRecency={roleRecency}
				unavailableMemberIds={unavailableMemberIds}
				unavailableMembers={effectiveCanManage ? unavailableMembers : undefined}
				pairedRoleIds={effectiveCanManage ? pairedIds : undefined}
				clubGuests={effectiveCanManage ? clubGuests : undefined}
				shareUrl={effectiveCanManage ? nudgeShareUrl : ""}
				meetingDate={effectiveCanManage ? nudgeDate : ""}
				meeting={meeting}
				timezone={timezone}
				actorMemberId={agendaMemberId}
				selfMemberId={agendaMemberId}
				onMetaSaved={async () => {
					await router.invalidate();
				}}
				requireIdentity={requireIdentity}
				contactedMemberIds={contactedMemberIds}
				onContacted={async (memberId, via) => {
					try {
						await setContacted({
							data: {
								memberId,
								meetingId: meeting.id,
								clubId: meeting.clubId,
								via,
							},
						});
						await router.invalidate();
					} catch (err) {
						toast.error(errMessage(err));
					}
				}}
				onUncontacted={async (memberId) => {
					try {
						await clearContacted({
							data: { memberId, meetingId: meeting.id, clubId: meeting.clubId },
						});
						await router.invalidate();
					} catch (err) {
						toast.error(errMessage(err));
					}
				}}
			/>

			{minutes.visible && minutes.data ? (
				<MeetingMinutes
					meetingId={meeting.id}
					minutes={minutes.data}
					program={minutes.program}
					meetingPast={locked || datePassed}
					canEdit={effectiveCanManage && minutes.canEdit}
					clubGuests={clubGuests}
					onMutated={() => router.invalidate()}
					email={
						minutesEmail
							? {
									clubId: meeting.clubId,
									clubName,
									meetingDate: meeting.scheduledAt,
									recipients: minutesEmail.recipients,
									skipped: minutesEmail.skipped,
								}
							: null
					}
				/>
			) : null}

			<Dialog open={addRoleOpen} onOpenChange={setAddRoleOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Add a role</DialogTitle>
					</DialogHeader>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							const roleId = String(
								new FormData(e.currentTarget).get("roleDefinitionId") ?? "",
							);
							if (roleId) void doAddRole(roleId);
						}}
						className="space-y-4"
					>
						<div className="space-y-2">
							<Label htmlFor="roleDefinitionId">Role</Label>
							<select
								id="roleDefinitionId"
								name="roleDefinitionId"
								required
								className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							>
								{addableRoles.map((r) => (
									<option key={r.id} value={r.id}>
										{r.name}
									</option>
								))}
							</select>
							<p className="text-xs text-muted-foreground">
								Picking a role already on this meeting adds another instance
								(e.g. “Timer 2”).
							</p>
						</div>
						<DialogFooter>
							<DialogClose asChild>
								<Button type="button" variant="outline">
									Cancel
								</Button>
							</DialogClose>
							<Button type="submit" disabled={addRoleBusy}>
								{addRoleBusy ? (
									<Loader2 className="size-4 animate-spin" />
								) : (
									"Add role"
								)}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</div>
	);
}
```

- [ ] **Step 2: Biome format/lint gate**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bun run check`
Expected: PASS (Biome may reorder imports — that is fine; re-run until clean).

- [ ] **Step 3: Typecheck**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bun run typecheck`
Expected: no errors. If `shell` is reported missing on the route context type, confirm `club.$clubId.tsx` `beforeLoad` returns `shell` (it does — the loader reads `context.shell`); the property is on the context.

- [ ] **Step 4: Run the existing PII guard + full unit suite for this area**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bunx vitest run src/routes/public-meeting-contact.guard.test.ts src/lib/meeting-lifecycle.test.ts`
Expected: PASS — the `context.shell ? getMeetingByKey : getPublicMeetingByKey` fork and the "no ungated `getMeetingByKey(`" assertion still hold.

- [ ] **Step 5: Commit**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views
git add src/routes/club.\$clubId.meeting.\$meetingId.tsx
git commit -m "$(cat <<'EOF'
feat(meeting): unify the pretty meeting URL for all audiences (#317)

/club/:clubId/meeting/:key is now the one canonical meeting page. A
signed-in admin gets full management (minutes, role sheets, add role,
complete/reopen, preview-as-member, contacted tracker); a member/anon
keeps the self-serve agenda, availability toggle, timing chip and guest
resources. The loader keeps the PII fork verbatim and loads minutes only
on the shell branch. Viewer comes from the pure resolveMeetingViewer;
the actions object is picked by capability.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AoR3mA2qL9gma7xzmzQve1
EOF
)"
```

---

## Task 3: Collapse `/meetings/:id` to a redirect

**Files:**
- Rewrite: `src/routes/_authed/meetings.$id.tsx`

**Why:** Every existing `/meetings/:id` link and bookmark must keep working, but there should be one meeting UI. The loader resolves the meeting's club slug + pretty date key (reusing `getMeeting`, which already returns both — avoids a second, divergent key-resolution path) and redirects to the canonical URL.

- [ ] **Step 1: Replace the entire file with the redirect stub**

Overwrite `src/routes/_authed/meetings.$id.tsx` with:

```tsx
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { getMeeting } from "#/server/meetings";

/**
 * Legacy management URL. The meeting page is now canonical at the pretty URL
 * `/club/:clubId/meeting/:key` (#317 unification). This route resolves the
 * meeting's club slug + date key and redirects there, so every existing
 * `/meetings/:id` link and bookmark keeps working through a single hop. An
 * unknown or non-uuid id → notFound(). Stays under `_authed` (always was); the
 * redirect target re-authorizes per audience on the pretty route.
 */
export const Route = createFileRoute("/_authed/meetings/$id")({
	loader: async ({ params }) => {
		const data = await getMeeting({ data: params.id }).catch(() => null);
		if (!data?.meeting) throw notFound();
		throw redirect({
			to: "/club/$clubId/meeting/$meetingId",
			params: { clubId: data.clubSlug, meetingId: data.urlKey },
		});
	},
});
```

- [ ] **Step 2: Biome + typecheck**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bun run check && bun run typecheck`
Expected: PASS. (A route whose loader always throws needs no `component`. If typecheck insists on one, add `component: () => null` to the route options.)

- [ ] **Step 3: Regenerate the route tree (sanity — no new/removed route path)**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bun run generate-routes && git diff --stat src/routeTree.gen.ts`
Expected: no diff (the route path `/_authed/meetings/$id` is unchanged; only its body changed). Never hand-edit `routeTree.gen.ts`.

- [ ] **Step 4: Commit**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views
git add src/routes/_authed/meetings.\$id.tsx
git commit -m "$(cat <<'EOF'
feat(meeting): redirect /meetings/:id to the canonical pretty URL (#317)

Collapses the legacy authed management route to a single redirect hop
onto /club/:clubId/meeting/:key. Reuses getMeeting for slug + date key;
unknown/non-uuid id → notFound(). Old links and bookmarks keep working.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AoR3mA2qL9gma7xzmzQve1
EOF
)"
```

---

## Task 4: Extend the service worker offline matcher

**Files:**
- Modify: `public/sw.js`

**Why:** The offline cache is hard-scoped to `url.pathname.startsWith("/meetings/")`. Now that the signed-in meeting view lives at the pretty URL, offline read + offline-minutes only work if the matcher also matches `/club/:slug/meeting/…`. Bumping `VERSION` invalidates the old caches on next activation.

- [ ] **Step 1: Bump the cache version**

In `public/sw.js`, change:

```js
const VERSION = "v2";
```

to:

```js
const VERSION = "v3";
```

- [ ] **Step 2: Widen `isOfflineRoute` and refresh its doc comment**

Replace the `isOfflineRoute` function (and its doc comment) with:

```js
/**
 * The only navigations we cache offline: a meeting Present/Print view, the
 * canonical pretty meeting page (`/club/<slug>/meeting/<key>`, which for a
 * signed-in member holds the minutes), or the legacy `/meetings/<id>` redirect
 * page. Kept scoped to meeting paths so no other navigation is written to the
 * offline cache.
 */
function isOfflineRoute(url) {
	return (
		url.pathname.endsWith("/present") ||
		url.pathname.endsWith("/print") ||
		/^\/club\/[^/]+\/meeting\//.test(url.pathname) ||
		url.pathname.startsWith("/meetings/")
	);
}
```

- [ ] **Step 3: Biome check (sw.js is plain JS; ensure no lint break)**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views
git add public/sw.js
git commit -m "$(cat <<'EOF'
feat(offline): cache the pretty meeting URL for offline read (#317/#176)

Extends the service worker's offline nav matcher to /club/:slug/meeting/…
so the unified meeting view (and its minutes) stay available offline, and
bumps the cache VERSION to v3 to invalidate stale caches. /meetings/ stays
matched so the legacy redirect page is cache-eligible.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AoR3mA2qL9gma7xzmzQve1
EOF
)"
```

---

## Task 5: App-shell breadcrumb for the pretty meeting page

**Files:**
- Modify: `src/components/app-shell.tsx`

**Why:** `crumbFor(pathname)` derives the shell header label from the path. A shell-wrapped signed-in member on `/club/:slug/meeting/:key` would otherwise fall through to the generic `"Workspace"`. Add a branch so the page keeps a proper "Manage · Meeting" header.

- [ ] **Step 1: Add the branch**

In `src/components/app-shell.tsx`, inside `crumbFor`, immediately **above** the existing line `if (pathname.startsWith("/meetings")) return "Manage · Meeting";`, add:

```js
	if (/^\/club\/[^/]+\/meeting(\/|$)/.test(pathname))
		return "Manage · Meeting";
```

- [ ] **Step 2: Typecheck + Biome**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bun run check && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views
git add src/components/app-shell.tsx
git commit -m "$(cat <<'EOF'
feat(shell): breadcrumb for the pretty meeting page (#317)

crumbFor() now labels /club/:slug/meeting/:key as "Manage · Meeting" so a
shell-wrapped member no longer falls through to the generic Workspace crumb.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AoR3mA2qL9gma7xzmzQve1
EOF
)"
```

---

## Task 6: Repoint `/next` straight to the pretty URL

**Files:**
- Modify: `src/routes/_authed/next.tsx`

**Why:** `/next` currently redirects to `/meetings/$id`, which (after Task 3) would redirect again. `getNextMeeting` returns `clubSlug` + `urlKey`, so send it straight to the canonical URL and save a hop.

- [ ] **Step 1: Change the redirect target**

In `src/routes/_authed/next.tsx`, replace:

```ts
			const data = await getNextMeeting({ data: clubId });
			if (data.meeting) {
				throw redirect({
					to: "/meetings/$id",
					params: { id: data.meeting.id },
				});
			}
			return { canManage: data.canManage };
```

with:

```ts
			const data = await getNextMeeting({ data: clubId });
			if (data.meeting) {
				throw redirect({
					to: "/club/$clubId/meeting/$meetingId",
					params: { clubId: data.clubSlug, meetingId: data.urlKey },
				});
			}
			return { canManage: data.canManage };
```

- [ ] **Step 2: Typecheck + Biome**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bun run check && bun run typecheck`
Expected: PASS. (`getNextMeeting`'s success return is `loadMeetingDetail(...)`, which includes `clubSlug` and `urlKey`; both are present whenever `data.meeting` is truthy.)

- [ ] **Step 3: Commit**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views
git add src/routes/_authed/next.tsx
git commit -m "$(cat <<'EOF'
feat(meeting): send /next straight to the pretty meeting URL (#317)

Avoids a double redirect now that /meetings/:id itself redirects to the
canonical /club/:clubId/meeting/:key.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AoR3mA2qL9gma7xzmzQve1
EOF
)"
```

---

## Task 7: Guard that anonymous loads never fetch minutes

**Files:**
- Modify: `src/routes/public-meeting-contact.guard.test.ts`

**Why:** The unification adds a `getMinutes` call to the pretty route's loader. This source-grep guard asserts that call stays gated behind `context.shell`, so an anonymous visitor (shell=false) never reaches minutes — matching the existing PII-boundary guards for `getMeetingByKey`.

- [ ] **Step 1: Add the assertion**

In `src/routes/public-meeting-contact.guard.test.ts`, inside the existing `describe("public meeting routes never ship contact (#37 PII)", …)` block, add this test after the existing `club.$clubId.meeting.$meetingId.tsx` case:

```ts
	// The unified pretty route loads minutes for a signed-in member (shell) but an
	// anonymous visitor (shell=false) must never reach getMinutes — it is gated on
	// the same `context.shell` flag as getMeetingByKey.
	it("club.$clubId.meeting.$meetingId.tsx gates getMinutes behind context.shell", () => {
		const src = read("club.$clubId.meeting.$meetingId.tsx");
		// Minutes are loaded for members…
		expect(src).toMatch(/getMinutes\(/);
		// …only as the shell branch of the ternary (guard token immediately before).
		expect(src).toMatch(/context\.shell\s*\?\s*await getMinutes\(/);
	});
```

- [ ] **Step 2: Run the guard test to verify it passes**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bunx vitest run src/routes/public-meeting-contact.guard.test.ts`
Expected: PASS — the loader from Task 2 formats the ternary as `context.shell\n\t\t\t? await getMinutes(…)`, and `\s*` spans the whitespace/newline. If it fails, confirm Task 2's loader uses exactly `context.shell ? await getMinutes({ data: data.meeting.id }).catch(…)` (Biome hoists `await` onto the `?` line).

- [ ] **Step 3: Commit**

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views
git add src/routes/public-meeting-contact.guard.test.ts
git commit -m "$(cat <<'EOF'
test(meeting): guard that anon loads never fetch minutes (#37 PII)

Asserts the unified pretty route reaches getMinutes only on the
context.shell branch, so an anonymous visitor never loads minutes.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01AoR3mA2qL9gma7xzmzQve1
EOF
)"
```

---

## Task 8: Full verification + manual QA

**Files:** none (verification only).

- [ ] **Step 1: Full gates**

Run each and confirm the actual output before claiming green:

```bash
cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views
bun run typecheck
bun run check
bun run test
```

Expected: typecheck clean; Biome clean; Vitest all-pass (including `meeting-lifecycle.test.ts`, `public-meeting-contact.guard.test.ts`, and `server-modules.guard.test.ts`). Set `TEST_DATABASE_URL` if the DB integration suites are otherwise skipped.

- [ ] **Step 2: Confirm the route tree is committed-clean**

Run: `cd /media/rasheed-bustamam/Extra/coding/tm-scheduler-unify-meeting-views && bun run generate-routes && git status --porcelain src/routeTree.gen.ts`
Expected: empty (no uncommitted route-tree drift).

- [ ] **Step 3: Manual QA via the /browse skill**

Use the `/browse` skill (set `GSTACK_CHROMIUM_NO_SANDBOX=1`). Start the dev server (`bun run dev`) and, using a **real v4-uuid** seed meeting (the `99999999-…` seed 500s on `zod.uuid()`):

1. **Anon on the pretty URL** (`/club/<slug>/meeting/<date-key>`, not signed in): agenda renders read/claim; availability toggle present; timing chip present; guest resources present; NO minutes / add-role / complete / preview controls; reading-width container.
2. **Signed-in admin on the same pretty URL** (a shell member of that club): full management — minutes, role sheets, + Add role, Complete/Reopen (per lifecycle), Preview-as-member, contacted tracker; wider container; "Copy member link".
3. **Preview-as-member**: clicking it hides management, shows guest resources + the preview banner; Exit preview restores management.
4. **Redirect**: visiting the old `/meetings/<uuid>` lands on `/club/<slug>/meeting/<date-key>` (one hop); an unknown uuid → not-found.
5. **`/next`**: redirects to the pretty URL directly (check the network tab shows a single redirect, not two).
6. **Nav strip** prev/next paging stays on the pretty URL.
7. **Locked/past meeting**: complete a meeting → locked banner for all; a past-but-open meeting still editable for an admin, read-only "already taken place" for a member/anon.

- [ ] **Step 4: Offline QA (kill-server-then-reload — /browse can't emulate offline)**

1. Sign in, load a pretty meeting URL online (primes the SW cache — confirm `v3` caches in Application → Cache Storage).
2. Stop the dev server. Reload the page → it still renders (agenda + minutes).
3. While offline, make a minutes edit → it queues locally; restart the server → the edit replays on reconnect.

- [ ] **Step 5: Finish the branch**

Once all gates and QA pass, use `superpowers:finishing-a-development-branch` to open the PR (or merge), referencing #317/#302 and the design spec.

---

## Self-review

**Spec coverage** (against `docs/superpowers/specs/2026-07-22-unify-meeting-views-design.md`):

- One canonical page adapting by audience → Task 2. ✓
- Loader keeps the `shell ? getMeetingByKey : getPublicMeetingByKey` fork verbatim; adds shell-only minutes/minutesEmail → Task 2 loader. ✓
- Nav strip targets the pretty URL (drop `/meetings/$id` override) → Task 2 (`<MeetingNavStrip clubId={clubId} items={navItems} />`, no `getLinkProps`). ✓
- `/meetings/:id` → redirect to the pretty date-key form; unknown id → notFound → Task 3. ✓
- Viewer computation unifying both routes (editable branch; locked-wrap) → Task 1 `resolveMeetingViewer`. ✓
- Section-visibility matrix (availability for all incl. admins — decision #4; guest resources hidden for admins; minutes/role-sheets/add-role/complete-reopen/preview admin-only; offline banner signed-in-only; adaptive width — decision #6) → Task 2. ✓
- Actions object picked by capability (privilege split) → Task 2 (`effectiveCanManage ? managerActions : selfActions`); manager-only `confirm/unconfirm/moveSpeaker/removeRole` present only on `managerActions` and gated by the tested viewer. ✓ (Standalone actions test intentionally dropped — see deviation #2.)
- Superadmin case (decision #5) — no code needed; impersonator `managerActorId`/`agendaMemberId` resolve to `null` (matches old route), documented in-code. ✓
- Service worker path coupling → Task 4. ✓
- App-shell page title → Task 5. ✓
- `/next` repoint → Task 6. ✓
- PII guard: existing guards stay green + new "anon never loads minutes" assertion → Task 7; `server-modules.guard.test.ts` unaffected (no server-fn module changed) → verified in Task 8. ✓
- Manual QA + offline QA → Task 8. ✓

**Placeholder scan:** none — every code step contains complete content; no TBD/TODO/"similar to".

**Type consistency:** `resolveMeetingViewer` input keys (`status`, `scheduledAt`, `timezone`, `currentMemberId`, `canManage`, `isTmod`, `isGrammarian`, `isSignedIn`, `now?`) are identical in Task 1's definition, its test, and Task 2's call site. `managerActorId`/`agendaMemberId`/`effectiveCanManage`/`nudgeShareUrl` are each defined once and used consistently. `EMPTY_MINUTES` matches the `getMinutes` catch-fallback shape used by the old authed route. `<MeetingAgenda>` optional props (`unavailableMembers?`, `pairedRoleIds?`, `clubGuests?`, `requireIdentity?`, `onContacted?`, `onUncontacted?`) verified optional; required `shareUrl`/`meetingDate`/`roster`/`contactedMemberIds`/`actorMemberId`/`selfMemberId` all supplied.

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
import { AttendanceGuestsGroup } from "#/components/club/attendance-guests-group";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
	buildPlanPanel,
	type PanelMember,
	type PlanStatus,
} from "#/lib/attendance-panel";
import { buildRollPanel, type RollRow } from "#/lib/roll-panel";
import type { AttendanceStatus, MinutesGuestRow } from "#/server/minutes-logic";

/** Chip copy. "No answer" is the ABSENCE of a row, so choosing it clears. */
const RUNG_LABELS: Record<PlanStatus, string> = {
	reached_out: "Asked",
	coming: "Coming",
	not_coming: "Not coming",
};

const MENU: { label: string; status: PlanStatus | null }[] = [
	{ label: "No answer", status: null },
	{ label: "Asked", status: "reached_out" },
	{ label: "Coming", status: "coming" },
	{ label: "Not coming", status: "not_coming" },
];

/** Roll mode's chip copy (spec D2/D3) — recording what actually happened, not
 *  another rung on the outreach ladder. */
const ROLL_LABELS: Record<AttendanceStatus, string> = {
	present: "Present",
	absent: "Absent",
	excused: "Excused",
};

const ROLL_MENU: { label: string; status: AttendanceStatus }[] = [
	{ label: "Present", status: "present" },
	{ label: "Absent", status: "absent" },
	{ label: "Excused", status: "excused" },
];

/** Tailwind's `lg` breakpoint (`min-width: 1024px`) — kept as one literal so the
 *  CSS class below and the JS desktop check can't drift apart. */
const LG_BREAKPOINT_PX = 1024;

function AttendanceRow({
	m,
	locked,
	meetingDate,
	shareUrl,
	pending,
	onWriteRung,
	onContacted,
}: {
	m: PanelMember;
	locked: boolean;
	meetingDate: string;
	shareUrl: string;
	pending: boolean;
	onWriteRung: (memberId: string, next: PlanStatus | null) => void;
	onContacted: (memberId: string) => void;
}) {
	return (
		<div className="flex items-center gap-2 py-1.5">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="truncate text-sm">{m.name}</span>
					{m.roleName ? <Badge variant="secondary">{m.roleName}</Badge> : null}
				</div>
				<NudgeButtons
					mode="attendance"
					name={m.name}
					preferredName={m.preferredName}
					phone={m.phone}
					email={m.email}
					meetingDate={meetingDate}
					shareUrl={shareUrl}
					onContacted={() => onContacted(m.id)}
				/>
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						disabled={locked || pending}
						aria-label={`${m.name} status`}
					>
						{m.status ? RUNG_LABELS[m.status] : "—"}
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{MENU.map((item) => (
						<DropdownMenuItem
							key={item.label}
							onSelect={() => onWriteRung(m.id, item.status)}
						>
							{item.label}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

/** Roll mode's status chip (spec D2/D3). A SUGGESTION (from the plan, never a
 *  record — `buildRollPanel` guarantees the two are mutually exclusive)
 *  renders dashed with a trailing "?" and commits in ONE tap: it must NOT open
 *  a menu, or roll call costs two taps per member in a room. A RECORDED status
 *  renders solid, like plan mode's rung, and opens a menu to change it. */
function RollChip({
	row,
	locked,
	pending,
	busy,
	onSetAttendance,
}: {
	row: RollRow;
	locked: boolean;
	pending: boolean;
	/** GLOBAL in-flight, not this row's — see the `busy` prop's doc below. */
	busy: boolean;
	onSetAttendance: (memberId: string, status: AttendanceStatus) => void;
}) {
	if (row.status === null && row.suggestion) {
		const suggestion = row.suggestion;
		return (
			<Button
				variant="outline"
				size="sm"
				className="border-dashed"
				disabled={locked || pending || busy}
				aria-label={`${row.name} status`}
				onClick={() => onSetAttendance(row.id, suggestion)}
			>
				{ROLL_LABELS[suggestion]}?
			</Button>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					disabled={locked || pending || busy}
					aria-label={`${row.name} status`}
				>
					{row.status ? ROLL_LABELS[row.status] : "—"}
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{ROLL_MENU.map((item) => (
					<DropdownMenuItem
						key={item.label}
						onSelect={() => onSetAttendance(row.id, item.status)}
					>
						{item.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function RollAttendanceRow({
	row,
	locked,
	meetingDate,
	shareUrl,
	hideContact,
	pending,
	busy,
	onSetAttendance,
}: {
	row: RollRow;
	locked: boolean;
	meetingDate: string;
	shareUrl: string;
	/** Once the meeting is `completed` nobody is being chased — the row skips
	 *  `NudgeButtons` entirely rather than rendering it with phone/email
	 *  nulled out, which would land on NudgeButtons' own "no contact on
	 *  file" copy and misstate a member who does have one on file. */
	hideContact: boolean;
	pending: boolean;
	busy: boolean;
	onSetAttendance: (memberId: string, status: AttendanceStatus) => void;
}) {
	return (
		<div className="flex items-center gap-2 py-1.5">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="truncate text-sm">{row.name}</span>
					{row.roleName ? (
						<Badge variant="secondary">{row.roleName}</Badge>
					) : null}
				</div>
				{hideContact ? null : (
					<NudgeButtons
						mode="attendance"
						name={row.name}
						preferredName={row.preferredName}
						phone={row.phone}
						email={row.email}
						meetingDate={meetingDate}
						shareUrl={shareUrl}
					/>
				)}
			</div>
			<RollChip
				row={row}
				locked={locked}
				pending={pending}
				busy={busy}
				onSetAttendance={onSetAttendance}
			/>
		</div>
	);
}

/**
 * Officer's attendance panel. PLAN mode (spec D2-D4) lists every active member
 * with where the outreach got to (no answer → asked → coming → not coming)
 * ahead of an upcoming meeting. ROLL mode (spec D2/D3) is meeting day: it
 * records who actually turned up, suggesting the plan's answer as a one-tap
 * dashed chip until the officer records a real one. `mode` is REQUIRED — a
 * default would let an existing call site silently keep plan behavior after
 * this landed, which is exactly the bug worth preventing. Presentational
 * either way: every write leaves as a callback, no server fn, no fetch, no
 * server state.
 */
export function MeetingAttendancePanel({
	mode,
	roster,
	plan,
	attendance,
	rungOverride,
	roleByMemberId,
	meetingDate,
	shareUrl,
	locked,
	phaseCompleted = false,
	busy = false,
	onWriteRung,
	onContacted,
	onSetAttendance,
	guests,
	clubGuests,
	onAddGuest,
	onRemoveGuest,
}: {
	mode: "plan" | "roll";
	roster: Omit<PanelMember, "status" | "roleName">[];
	plan: { memberId: string; status: PlanStatus }[];
	/** Roll mode only. Recorded rows; ignored in plan mode. */
	attendance?: { memberId: string; status: AttendanceStatus }[];
	/** Optimistic overrides from the route, keyed by member. A key present with
	 *  value `null` means "optimistically cleared" — distinct from absent,
	 *  which means "no override". */
	rungOverride: Readonly<Record<string, PlanStatus | null>>;
	roleByMemberId: Readonly<Record<string, string>>;
	meetingDate: string;
	shareUrl: string;
	locked: boolean;
	/** Roll mode only. Once the meeting is a historical record nobody is being
	 *  chased, so contact links disappear. Defaults false so plan mode's
	 *  existing callers need no change. */
	phaseCompleted?: boolean;
	/**
	 * Roll mode only. The write path's GLOBAL in-flight signal — true while ANY
	 * roll write (or a Minutes-card write, or a reconnect drain) is outstanding
	 * on the meeting's one `useOfflineMinutes` instance.
	 *
	 * It exists because that hook's `mutate()` REFUSES rather than queues while
	 * it is busy (`use-offline-minutes.ts`: `if (busy || draining) return;`) and
	 * refuses SILENTLY — no toast, no throw. `pending` below disables one row,
	 * so without this every other chip stayed tappable and threw the tap away:
	 * an officer taking roll on a phone taps down a 25-name roster at
	 * conversational pace, each tap costing a round trip plus a full
	 * `router.invalidate()`, and a large fraction of them do nothing with
	 * nothing on screen to say so. The surface roll mode replaces
	 * (`AttendanceSection`) had no such hole — it put `disabled={busy}` on every
	 * member's control and on the guest adder.
	 *
	 * So this is NOT a nicety: the UI's disabled condition has to match the
	 * queue's refusal condition, or the two disagree and the gap is invisible.
	 * Kept SEPARATE from `pending` on purpose — `pending` also drives the
	 * per-row affordance, and setting it globally would make all 25 rows look
	 * like the one being written.
	 *
	 * Defaults false so plan mode's callers need no change; plan writes go
	 * straight to `setPlannedAttendance` and never touch the offline queue, so
	 * `AttendanceRow` deliberately does not read it.
	 */
	busy?: boolean;
	/** One writer for both directions; `null` clears. Two callbacks made the
	 *  clear path a separate thing to remember at every call site. */
	onWriteRung: (
		memberId: string,
		next: PlanStatus | null,
	) => void | Promise<void>;
	onContacted: (memberId: string) => void | Promise<void>;
	/** Roll mode only. Fired by a chip or a dashed suggestion. */
	onSetAttendance?: (
		memberId: string,
		status: AttendanceStatus,
	) => void | Promise<void>;
	/** Roll mode only — the Guests group. Omitted (rather than defaulted to
	 *  `[]`) so a caller that has not wired guests yet renders nothing, not an
	 *  empty group. */
	guests?: MinutesGuestRow[];
	clubGuests?: { id: string; name: string }[];
	onAddGuest?: (payload: {
		guestId?: string;
		newGuest?: { name: string; email?: string; phone?: string };
	}) => void | Promise<void>;
	onRemoveGuest?: (guestId: string) => void | Promise<void>;
}) {
	const roll = mode === "roll";

	// MODE-SPECIFIC lock. `locked` is exactly `status === "completed"`
	// (`meeting-lifecycle.ts`), and ROLL mode must not respect it: correcting a
	// mis-marked attendance after a meeting is closed out is a normal club task,
	// minutes here are often finished days later, and everything around this
	// already allows it — `setAttendance` / `addMinutesGuest` /
	// `removeMinutesGuest` gate only on `assertAttendanceRecordable` (has the day
	// arrived), with no view of `status`, and the Minutes card's own recorder
	// (`AttendanceSection`, which roll mode replaces) gated on `canEdit` alone,
	// which never considered `status` either. Left on `locked`, roll mode would be
	// STRICTER than the surface it replaces and the only correction route would be
	// Reopen.
	//
	// PLAN mode keeps respecting it — changing PLANNED attendance for a meeting
	// that already happened is meaningless. Hence one value branching on the mode
	// HERE rather than a `locked={false}` at the call site. Two reasons, neither
	// about how many places read it: the prop is named for the MEETING's state, so
	// a route passing `false` for a genuinely completed meeting would be stating
	// something untrue — the next reader debugging a lifecycle question would trust
	// it — and the mode is this component's own business, so the exception belongs
	// where the mode is known and not duplicated into every caller that ever
	// renders roll mode.
	//
	// `pending` still disables every control during an in-flight write; this only
	// removes the lifecycle gate.
	const writesLocked = roll ? false : locked;

	// Per-row in-flight state, lifted from OutreachPanel: a BUSY guard against a
	// rapid double-tap, not the source of the displayed value — that comes from
	// `rungOverride`, which the route owns.
	const [pendingId, setPendingId] = useState<string | null>(null);

	// Mobile collapse (spec D4): below `lg` PLAN mode starts collapsed to its
	// counts line so a big roster does not push the agenda off screen; at `lg`
	// and up it is always shown. Starting `false` (rather than reading `window`
	// during render) keeps the server render and the client's first render in
	// agreement — same guard `NudgeButtons` uses, for the same reason: a value
	// computed before hydration makes the two disagree and React has to
	// reconcile a mismatch.
	//
	// SUBSCRIBED, not sampled. This must track the SAME breakpoint the toggle
	// button's `lg:hidden` tracks, and CSS re-evaluates that on every resize. A
	// one-shot `window.innerWidth` read froze at mount, so rotating a tablet
	// from portrait to landscape hid the toggle (CSS, live) while `isDesktop`
	// stayed `false` (JS, stale) — leaving a header with no rows and no visible
	// control to reveal them, on exactly the device a VPE runs the rail on.
	const [isDesktop, setIsDesktop] = useState(false);
	useEffect(() => {
		const mq = window.matchMedia(`(min-width: ${LG_BREAKPOINT_PX}px)`);
		const sync = () => setIsDesktop(mq.matches);
		sync();
		mq.addEventListener("change", sync);
		return () => mq.removeEventListener("change", sync);
	}, []);
	const [expanded, setExpanded] = useState(false);
	// ROLL mode opens by default, even on mobile — it IS the task on meeting
	// day, unlike plan mode, which stays collapsed until asked.
	const showRows = roll || expanded || isDesktop;

	// Apply the override BEFORE deriving either panel, so the sort and the
	// counts reflect the optimistic state too — otherwise a chip jumps to a new
	// bucket a beat after it is tapped, and the counts line disagrees with the
	// chips. `!== undefined` (not `??`) because a key present with value `null`
	// means "optimistically cleared", distinct from the key being absent.
	// Shared by both modes: roll mode reads this same plan as its suggestion
	// source, so the optimistic override applies there too.
	const effectivePlanForPanel = roster
		.map((m) => ({
			memberId: m.id,
			status:
				rungOverride[m.id] !== undefined
					? rungOverride[m.id]
					: (plan.find((p) => p.memberId === m.id)?.status ?? null),
		}))
		.filter(
			(p): p is { memberId: string; status: PlanStatus } => p.status !== null,
		);

	// Derive once, branching on mode, so the two derivations never both run —
	// they share no sort, no counts and no row shape.
	const rollPanel = roll
		? buildRollPanel({
				roster,
				attendance: attendance ?? [],
				plan: effectivePlanForPanel,
				roleByMemberId,
			})
		: null;
	const planPanel = roll
		? null
		: buildPlanPanel({ roster, plan: effectivePlanForPanel, roleByMemberId });
	const countsLine = rollPanel?.countsLine ?? planPanel?.countsLine ?? "";

	async function writeRung(memberId: string, next: PlanStatus | null) {
		setPendingId(memberId);
		try {
			await onWriteRung(memberId, next);
		} finally {
			setPendingId(null);
		}
	}

	async function contacted(memberId: string) {
		// Gated for the same reason the dropdown trigger is: this is a WRITE (no
		// answer → asked), it just happens to be triggered by tapping a message
		// draft rather than picking a rung. The dropdown was already gated and this
		// path was not, and the difference only becomes visible as a hole the moment
		// the panel is rendered in another phase. The draft itself still opens; a
		// locked meeting just stops recording against it.
		//
		// `writesLocked`, not raw `locked` — identical here, since this is a PLAN
		// rung and only `AttendanceRow` wires it, but reading the same value as
		// every other write in this component is what keeps the two from drifting
		// if a roll row ever grows an `onContacted`.
		if (writesLocked) return;
		setPendingId(memberId);
		try {
			await onContacted(memberId);
		} finally {
			setPendingId(null);
		}
	}

	async function setAttendance(memberId: string, status: AttendanceStatus) {
		setPendingId(memberId);
		try {
			await onSetAttendance?.(memberId, status);
		} finally {
			setPendingId(null);
		}
	}

	// Once the meeting is `completed`, nobody is being chased over a
	// historical record — every row skips `NudgeButtons` entirely (see
	// `RollAttendanceRow`) rather than rendering it with contact nulled out,
	// which would read as "no contact on file" for a member who has one.
	const hideContact = roll && phaseCompleted;

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<CardTitle>{roll ? "Attendance" : "Planned attendance"}</CardTitle>
						<span className="text-xs text-[var(--sea-ink-soft)]">
							{countsLine}
						</span>
					</div>
					{/* Toggle only exists in PLAN mode. Below `lg` it flips the
					 *  collapse; roll mode is always expanded there (see `showRows`),
					 *  so the control would have nothing to do. At `lg` and up plan
					 *  mode's roster is always shown regardless, which is why the
					 *  button there is CSS-hidden rather than removed — still one DOM
					 *  node either way. */}
					{roll ? null : (
						<Button
							variant="ghost"
							size="sm"
							className="lg:hidden"
							onClick={() => setExpanded((v) => !v)}
						>
							{expanded ? (
								<>
									Hide
									<ChevronUp className="size-4" aria-hidden />
								</>
							) : (
								<>
									Show
									<ChevronDown className="size-4" aria-hidden />
								</>
							)}
						</Button>
					)}
				</div>
			</CardHeader>
			{/* The rows are absent from the DOM entirely when collapsed — not
			 *  merely CSS-hidden, which would still expose every member's name to a
			 *  screen reader (and make the collapse untestable). */}
			{showRows ? (
				<CardContent>
					{roll
						? (rollPanel?.rows ?? []).map((row) => (
								<RollAttendanceRow
									key={row.id}
									row={row}
									locked={writesLocked}
									meetingDate={meetingDate}
									shareUrl={shareUrl}
									hideContact={hideContact}
									pending={pendingId === row.id}
									busy={busy}
									onSetAttendance={setAttendance}
								/>
							))
						: (planPanel?.rows ?? []).map((m) => (
								<AttendanceRow
									key={m.id}
									m={m}
									locked={writesLocked}
									meetingDate={meetingDate}
									shareUrl={shareUrl}
									pending={pendingId === m.id}
									onWriteRung={writeRung}
									onContacted={contacted}
								/>
							))}
					{roll && guests ? (
						/* `writesLocked` here too, and for the same reason as the chips:
						 *  this group only ever renders in roll mode, the guest writes
						 *  behind it (`addMinutesGuest` / `removeMinutesGuest`) gate only
						 *  on `assertAttendanceRecordable`, and the `AttendanceSection`
						 *  this replaces let an officer add a missed guest to a completed
						 *  meeting. Leaving it on raw `locked` would fix the member chips
						 *  and leave the guest list dead on exactly the meeting whose
						 *  record is being corrected.
						 *
						 *  `|| busy` because this group's `locked` is documented as "disables
						 *  controls", not as the meeting's lifecycle, and it is the only
						 *  channel it has: with the lifecycle gate off in roll mode its
						 *  controls were disabled by NOTHING during a write, and it closes
						 *  its popover unconditionally after `onAddGuest` — so a guest add
						 *  the queue silently refused looked like it had succeeded. Same
						 *  global signal as the chips, for the same reason. */
						<AttendanceGuestsGroup
							guests={guests}
							clubGuests={clubGuests ?? []}
							locked={writesLocked || busy}
							onAddGuest={onAddGuest ?? (() => {})}
							onRemoveGuest={onRemoveGuest ?? (() => {})}
						/>
					) : null}
				</CardContent>
			) : null}
		</Card>
	);
}

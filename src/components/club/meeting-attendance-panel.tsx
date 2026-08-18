import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useState } from "react";
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
	type PanelRole,
	type PlanStatus,
} from "#/lib/attendance-panel";

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
	// COMPUTED prop, deliberately named. A member holding a slot gets the same
	// draft the agenda's slot card sends — asking "are you coming?" of someone
	// you already put on the programme wastes the ask. Uses the BASE role name,
	// never the numbered code: "you're our Speaker 1" reads as a mail merge.
	const nudgeMode = m.role
		? { mode: "confirm" as const, roleName: m.role.roleName }
		: { mode: "attendance" as const };

	// An inference must not read as an answer. Same visible word, different
	// accessible name, muted chip.
	const statusAriaLabel = m.assumed
		? `${m.name} status: Coming — assumed, role confirmed`
		: `${m.name} status`;

	return (
		<div className="flex flex-col gap-1.5 border-b border-border/60 py-2.5 last:border-b-0">
			{/* Identity line. The name owns it — at 2-4 characters the role code
			 *  costs it almost nothing, which is the whole reason the code replaced
			 *  the full role name here. */}
			<div className="flex items-start gap-1.5">
				<span className="min-w-0 flex-1 break-words text-sm font-medium">
					{m.name}
				</span>
				{m.role ? (
					<Badge
						variant={m.assumed ? "default" : "secondary"}
						className="mt-0.5 shrink-0"
					>
						{/* An ICON, not a "✓" character: a literal would join the code in
						 *  `textContent` and break every `getByText(code)` query. */}
						{m.assumed ? <Check aria-hidden /> : null}
						{/* The CODE is decorative to a screen reader — it hears the full
						 *  role from the sr-only span beside it, so the accessible name is
						 *  "Toastmaster" rather than "TD".
						 *
						 *  `aria-label` on the Badge itself is not an option, which is what
						 *  this shape exists to avoid: a Badge renders a bare <span>, which
						 *  maps to role `generic`, and ARIA 1.2 PROHIBITS `aria-label`
						 *  there — axe-core flags `aria-prohibited-attr` and honouring
						 *  varies by screen reader. `title` stays on the visible code, where
						 *  a mouse user's pointer actually lands. */}
						<span aria-hidden title={m.role.roleName}>
							{m.role.code}
						</span>
						<span className="sr-only">{m.role.roleName}</span>
					</Badge>
				) : null}
			</div>
			{/* Action line. One right-aligned cluster, so every row in the rail
			 *  shares one right edge — this is the alignment fix. Nothing is
			 *  vertically centred across a variable-height block any more. */}
			<div className="flex items-center justify-end gap-1.5">
				<NudgeButtons
					{...nudgeMode}
					iconOnly
					name={m.name}
					preferredName={m.preferredName}
					phone={m.phone}
					email={m.email}
					meetingDate={meetingDate}
					shareUrl={shareUrl}
					onContacted={() => onContacted(m.id)}
				/>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							disabled={locked || pending}
							aria-label={statusAriaLabel}
							className={m.assumed ? "text-muted-foreground" : undefined}
						>
							{m.status ? RUNG_LABELS[m.status] : "Ask"}
							<ChevronDown className="size-3.5 opacity-60" aria-hidden />
						</Button>
					</DropdownMenuTrigger>
					{/* "No answer" on an ASSUMED row does not MOVE the row — the
					 *  confirmed slot still stands — but it is not a no-op. If the
					 *  officer already messaged them, `m.storedStatus` is
					 *  `reached_out`, and picking this DELETES that row and writes an
					 *  activity entry while nothing on screen changes. To say they are
					 *  out, the officer picks "Not coming", which is an explicit answer
					 *  and outranks the inference. */}
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
		</div>
	);
}

/**
 * Officer's planned-attendance panel, plan mode (spec D2-D4). Lists every
 * active member with where the outreach got to (no answer → asked → coming →
 * not coming) and lets the officer set a rung or message them. Presentational:
 * every write leaves as a callback, no server fn, no fetch, no server state.
 */
export function MeetingAttendancePanel({
	roster,
	plan,
	rungOverride,
	roleByMemberId,
	meetingDate,
	shareUrl,
	locked,
	onWriteRung,
	onContacted,
}: {
	/** DERIVED from `buildPlanPanel`'s own parameter, never a second hand-listed
	 *  `Omit`. This read `Omit<PanelMember, "status" | "roleName">`, and when
	 *  `roleName` was replaced by `role`/`storedStatus`/`assumed` the omit list
	 *  went stale silently: `Omit` does not constrain its keys, so omitting a
	 *  field that no longer exists is legal and the three NEW derived fields
	 *  simply became REQUIRED of every caller — a roster nobody can supply.
	 *  Pointing at the function this value is passed to makes that drift
	 *  unrepresentable. */
	roster: Parameters<typeof buildPlanPanel>[0]["roster"];
	plan: { memberId: string; status: PlanStatus }[];
	/** Optimistic overrides from the route, keyed by member. A key present with
	 *  value `null` means "optimistically cleared" — distinct from absent,
	 *  which means "no override". */
	rungOverride: Readonly<Record<string, PlanStatus | null>>;
	roleByMemberId: Readonly<Record<string, PanelRole>>;
	meetingDate: string;
	shareUrl: string;
	locked: boolean;
	/** One writer for both directions; `null` clears. Two callbacks made the
	 *  clear path a separate thing to remember at every call site. */
	onWriteRung: (
		memberId: string,
		next: PlanStatus | null,
	) => void | Promise<void>;
	onContacted: (memberId: string) => void | Promise<void>;
}) {
	// Per-row in-flight state, lifted from OutreachPanel: a BUSY guard against a
	// rapid double-tap, not the source of the displayed value — that comes from
	// `rungOverride`, which the route owns.
	const [pendingId, setPendingId] = useState<string | null>(null);

	// Mobile collapse (spec D4): below `lg` the panel starts collapsed to its
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
	const showRows = expanded || isDesktop;

	// Apply the override BEFORE calling buildPlanPanel, so the sort and the
	// counts reflect the optimistic state too — otherwise a chip jumps to a new
	// bucket a beat after it is tapped, and the counts line disagrees with the
	// chips. `!== undefined` (not `??`) because a key present with value `null`
	// means "optimistically cleared", distinct from the key being absent.
	const effectivePlan = roster
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

	const { rows, countsLine } = buildPlanPanel({
		roster,
		plan: effectivePlan,
		roleByMemberId,
	});

	async function writeRung(memberId: string, next: PlanStatus | null) {
		setPendingId(memberId);
		try {
			await onWriteRung(memberId, next);
		} finally {
			setPendingId(null);
		}
	}

	async function contacted(memberId: string) {
		// Gated on `locked` for the same reason the dropdown trigger is: this is a
		// WRITE (no answer → asked), it just happens to be triggered by tapping a
		// message draft rather than picking a rung. Today the panel only renders
		// for an `upcoming` meeting, so `locked` is always false and this is
		// inert — but the dropdown was already gated and this path was not, and
		// the difference only becomes visible as a hole the moment the panel is
		// rendered in another phase. The draft itself still opens; a locked
		// meeting just stops recording against it.
		if (locked) return;
		setPendingId(memberId);
		try {
			await onContacted(memberId);
		} finally {
			setPendingId(null);
		}
	}

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<CardTitle>Planned attendance</CardTitle>
						<span className="text-xs text-[var(--sea-ink-soft)]">
							{countsLine}
						</span>
					</div>
					{/* Toggle only makes sense below `lg` — at `lg` and up the roster is
					 *  always shown, so the button is CSS-hidden there rather than
					 *  removed, since it is still a single DOM node either way. */}
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
				</div>
			</CardHeader>
			{/* The rows are absent from the DOM entirely when collapsed — not
			 *  merely CSS-hidden, which would still expose every member's name to a
			 *  screen reader (and make the collapse untestable). */}
			{showRows ? (
				<CardContent>
					{rows.map((m) => (
						<AttendanceRow
							key={m.id}
							m={m}
							locked={locked}
							meetingDate={meetingDate}
							shareUrl={shareUrl}
							pending={pendingId === m.id}
							onWriteRung={writeRung}
							onContacted={contacted}
						/>
					))}
				</CardContent>
			) : null}
		</Card>
	);
}

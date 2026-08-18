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
	//
	// Branches on the ANSWER as well as the slot. A member who declined still
	// HOLDS their slot until someone reassigns it, so keying on `m.role` alone
	// drafted "just confirming you're our Toastmaster" to someone whose own row
	// reads "Not coming" — the panel showing the officer a decline and then
	// handing them a message asserting acceptance. The attendance draft is a
	// re-ask rather than a false claim, which is the best the existing modes
	// offer; the message that case really wants ("can you hand the role off?")
	// is a new mode and a separate change.
	const nudgeMode =
		m.role && m.status !== "not_coming"
			? { mode: "confirm" as const, roleName: m.role.roleName }
			: { mode: "attendance" as const };

	// An assumed Coming can sit ON TOP OF a real stored rung, and without showing
	// it two of the four menu choices are invisible: picking "Asked" writes
	// `reached_out`, which cannot outrank the inference, so the control returned
	// from its disabled round trip reading exactly what it read before — which
	// reads as "it didn't save", so the officer taps again. Surfacing the stored
	// rung is what makes both that pick and its undo observable.
	//
	// On an assumed row `storedStatus` can only be `null` or `reached_out`: an
	// explicit `coming`/`not_coming` makes `answered` true, which makes `assumed`
	// false. So this is the one case there is to surface, not a partial view.
	const alsoAsked = m.assumed && m.storedStatus === "reached_out";

	// Derived ONCE and used for both the visible label and the announced name, so
	// the two cannot disagree about what this row says. The visible suffix uses
	// the counts line's separator; the announced one spells it out, because "·"
	// is not read aloud.
	const statusLabel = m.status ? RUNG_LABELS[m.status] : "Ask";
	const visibleLabel = alsoAsked ? `${statusLabel} · asked` : statusLabel;
	const statusAnnouncement = `${m.name} status: ${statusLabel}${
		m.assumed ? " — assumed, role confirmed" : ""
	}${alsoAsked ? ", already asked" : ""}`;

	return (
		<li className="flex flex-col gap-1.5 border-b border-border/60 py-2.5 last:border-b-0">
			{/* Identity line. The name owns it — at 2-4 characters the role code
			 *  costs it almost nothing, which is the whole reason the code replaced
			 *  the full role name here. */}
			<div className="flex items-start gap-1.5">
				<span className="min-w-0 flex-1 break-words text-sm font-medium">
					{m.name}
				</span>
				{/* No `mt-0.5` on the badge below: under `items-start` its inner text
				 *  centre already lands within a pixel of the name's (11px vs 10px
				 *  against Tailwind v4 defaults — `text-xs`/`py-0.5`/1px border against
				 *  `text-sm`), so nudging it down by 2px put it ~3px BELOW the name's
				 *  optical line. `items-start` is the whole mechanism. */}
				{m.role ? (
					<Badge
						variant={m.assumed ? "default" : "secondary"}
						className="shrink-0"
					>
						{/* An ICON, not a "✓" character, for two reasons that are about
						 *  rendering rather than tests: `badgeVariants` styles a direct-child
						 *  svg (`[&>svg]:size-3`), which a text glyph gets none of, and
						 *  `aria-hidden` keeps it out of the accessible name — a literal
						 *  would be announced ("check mark") beside the role it decorates. */}
						{m.assumed ? <Check aria-hidden /> : null}
						{/* The CODE is decorative to a screen reader — it hears the full
						 *  role from the sr-only span beside it, so the accessible name is
						 *  "Toastmaster" rather than "TD".
						 *
						 *  `aria-label` on the Badge itself is not an option, which is what
						 *  this shape exists to avoid: a Badge renders a bare <span>, which
						 *  maps to role `generic`, and ARIA 1.2 PROHIBITS `aria-label`
						 *  there, with honouring varying by screen reader. `title` stays on
						 *  the visible code, where a mouse user's pointer actually lands. */}
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
						{/* The accessible name is COMPOSED FROM CONTENT, never an
						 *  `aria-label`. `aria-label` OVERRIDES content, so labelling this
						 *  `"${m.name} status"` meant the answer itself — Coming / Asked /
						 *  Not coming / Ask — reached no screen reader at all on any row
						 *  where someone had actually replied, on a rail whose entire
						 *  purpose is "who is coming". Worse, it was ASYMMETRIC: assumed
						 *  rows folded their status into the label and answered rows did
						 *  not, so an inference told an AT user strictly more than a real
						 *  answer did. Composing keeps the visible label and the announced
						 *  one the same string by construction. `hover:text-muted-foreground`
						 *  rides along with the muting because the `outline` variant's
						 *  `hover:text-accent-foreground` is a class+pseudo-class (0-2-0)
						 *  and beats a bare `text-muted-foreground` (0-1-0) on hover. */}
						<Button
							variant="outline"
							size="sm"
							disabled={locked || pending}
							className={
								m.assumed
									? "text-muted-foreground hover:text-muted-foreground"
									: undefined
							}
						>
							{/* ONE sr-only string carries the whole name, with the visible
							 *  label `aria-hidden` beside it — the same shape as the badge
							 *  above, for the same reason. Both strings derive from
							 *  `statusLabel`, so what is shown and what is announced cannot
							 *  drift apart.
							 *
							 *  Why one span rather than a sr-only prefix beside a plain
							 *  label: the separator between sibling children is
							 *  DISPLAY-DEPENDENT. accname leaves it to the implementation
							 *  (w3c/accname#3); `dom-accessibility-api` inserts " " only when
							 *  a child's computed `display` is not `inline`
							 *  (`accessible-name-and-description.js:250-253`). `sr-only` sets
							 *  `position: absolute`, which blockifies (CSS Display 3 §2.7),
							 *  so a split name would gain its space in a real browser but
							 *  NOT under jsdom, where no stylesheet loads and the span stays
							 *  `inline` — announcing "status:Ask" in the harness while
							 *  reading correctly in production. One span never splits the
							 *  string, so it is indifferent to that rule in both
							 *  environments. */}
							<span className="sr-only">{statusAnnouncement}</span>
							<span aria-hidden>{visibleLabel}</span>
							<ChevronDown className="size-3.5 opacity-60" aria-hidden />
						</Button>
					</DropdownMenuTrigger>
					{/* On an ASSUMED row neither "Asked" nor "No answer" can MOVE the
					 *  row — the confirmed slot still stands and outranks both — but
					 *  neither is a no-op, and both are now VISIBLE through the
					 *  `· asked` suffix the label carries. "Asked" writes
					 *  `reached_out`, taking the row from "Coming" to "Coming · asked";
					 *  "No answer" DELETES that row and writes an activity entry,
					 *  taking it back. Without the suffix both round-tripped to an
					 *  unchanged label, which reads as "it didn't save" and gets tapped
					 *  again. To say they are OUT, the officer picks "Not coming",
					 *  which is an explicit answer and does outrank the inference. */}
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
		</li>
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
					{/* A LIST, not forty sibling divs: without it an AT user gets no set
					 *  size and no position within it, on the one surface whose job is
					 *  "how many of us are there and where am I in the chase".
					 *
					 *  `role="list"` is NOT redundant with the implicit one. Tailwind's
					 *  preflight sets `list-style: none` on every `ul`, and WebKit drops
					 *  the implicit list role when list styling is removed — so on the
					 *  iPad this rail is actually run from, VoiceOver would announce no
					 *  list at all, losing the set size above at exactly the place it was
					 *  added to help. Both suppressions below are that same point: the
					 *  role is redundant to a STATIC reader and load-bearing to a real
					 *  one. */}
					{/* biome-ignore lint/a11y/noRedundantRoles: not redundant in practice — preflight's `list-style: none` makes WebKit drop the implicit role */}
					{/* biome-ignore lint/a11y/useSemanticElements: this already IS a <ul>; the rule misfires when the explicit role matches the element */}
					<ul role="list">
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
					</ul>
				</CardContent>
			) : null}
		</Card>
	);
}

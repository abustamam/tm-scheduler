import { ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { AttendanceGuestsGroup } from "#/components/club/attendance-guests-group";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import {
	SyncStatus,
	type SyncStatusProps,
} from "#/components/club/sync-status";
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
	type PanelRowRole,
	type PlanStatus,
} from "#/lib/attendance-panel";
import { buildRollPanel, type RollRow } from "#/lib/roll-panel";
import { cn } from "#/lib/utils.ts";
import type { AttendanceStatus, MinutesGuestRow } from "#/server/minutes-logic";

/** Chip copy. "No answer" is the ABSENCE of a row, so choosing it clears. */
const RUNG_LABELS: Record<PlanStatus, string> = {
	reached_out: "Asked",
	coming: "Coming",
	not_coming: "Not coming",
};

/** The two qualifiers a Coming can carry on the status control. MUTUALLY
 *  EXCLUSIVE by construction — `alsoAsked ? ASKED_WORD : m.assumed ?
 *  ASSUMED_WORD : null` — and `asked` WINS when both apply, because it is the
 *  more actionable of the two: it says the officer already chased this member,
 *  which "assumed" does not.
 *
 *  So the visible label and the announced name deliberately DIVERGE on exactly
 *  that row: visible is `"Coming · asked"`, announced is
 *  `"… status: Coming — assumed, role confirmed, already asked"`. `ASSUMED_WORD`
 *  is announced there and not shown. That is not a drift to fix — the row's
 *  assumed-ness is carried VISIBLY by the control's muting and carried in WORDS
 *  only in the announcement, and the split is pinned by the panel's own suite
 *  with its rationale.
 *
 *  The width is what forces it, and the number is measured, so do not "fix" this
 *  by stacking the two: the trigger is a fixed `w-44` (176px) track sized against
 *  the widest label it must hold, `"Coming · assumed"`. `"Coming · assumed ·
 *  asked"` does not fit, and widening the track spends ~50px of a ~292px rail
 *  saying twice what "asked" already implies (nobody answered). */
const ASSUMED_WORD = "assumed";
const ASKED_WORD = "asked";

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

/**
 * The rail's row, SHARED by both modes — three components rather than one, so
 * each mode still owns what goes inside its action line.
 *
 * These exist because the last attempt at sharing was a comment. `RollAttendanceRow`
 * claimed "sharing `AttendanceRow`'s shell verbatim is what stops the two modes
 * drifting apart", and what it had actually copied was the `<li>` class list: the
 * CONTENTS stayed pre-#594, so every fix that rebuild made for this 340px column
 * was missing from half the rows — a `truncate` single-line cutoff on unbounded
 * names, the full role name in an unshrinkable `whitespace-nowrap` badge (~136px
 * of a ~292px column for "Toastmaster of the Day"), word-labelled contact buttons,
 * and no fixed action track at all, so the chip stretched full width and the
 * rail's "one right edge" held for the plan rows only. jsdom performs no layout,
 * so nothing here could see any of it.
 *
 * A copied class list is not sharing. What is shared is the code: both modes call
 * these three, so the next restyle of a row reaches both by construction and a
 * mode-specific deviation has to be written as one.
 */
function PanelRow({ children }: { children: ReactNode }) {
	return (
		<li className="flex flex-col gap-1.5 border-b border-border/60 py-2.5 last:border-b-0">
			{children}
		</li>
	);
}

/** Identity line. The name owns it — at 2-4 characters the role code costs it
 *  almost nothing, which is the whole reason the code replaced the full role name
 *  here.
 *
 *  `PanelRowRole` (`{ code, roleName }`) is the prop, so ROLL mode had to start
 *  carrying the code: `buildRollPanel` read `?.roleName` only, and the full name
 *  in a `shrink-0 whitespace-nowrap` Badge is an unshrinkable block that a long
 *  role name pushes the rest of the row out of. */
function PanelIdentityLine({
	name,
	role,
}: {
	name: string;
	role: PanelRowRole | null;
}) {
	return (
		<div className="flex items-start gap-1.5">
			{/* `break-words` wraps an unbroken name rather than cutting it off;
			 *  `line-clamp-2` is the other half of spec §3 and the half that was never
			 *  implemented. `name` is unbounded user data, so with neither a truncation
			 *  nor a clamp one member can grow their row without limit and push the
			 *  rest of a 40-row rail off screen. Two lines, not one: `line-clamp-1`
			 *  would reintroduce the single-line cutoff `truncate` was removed to fix. */}
			<span className="line-clamp-2 min-w-0 flex-1 break-words text-sm font-medium">
				{name}
			</span>
			{/* No `mt-0.5` on the badge below: under `items-start` its inner text
			 *  centre already lands within a pixel of the name's (11px vs 10px
			 *  against Tailwind v4 defaults — `text-xs`/`py-0.5`/1px border against
			 *  `text-sm`), so nudging it down by 2px put it ~3px BELOW the name's
			 *  optical line. `items-start` is the whole mechanism. */}
			{role ? (
				/* ONE AXIS: this badge means "holds a role on this meeting", and reads
				 * the same for everyone who does. It carried a second axis until the fix
				 * above — `variant={m.assumed ? "default" : "secondary"}` plus a Check —
				 * and that axis was wrong on its own terms as well as backwards: on a
				 * DOUBLE-BOOKED member `confirmed` is the OR across their slots
				 * (`buildPanelRoleMap`), so the badge rendered "TD ✓" against a slot they
				 * had not confirmed. Deleting the second axis closes that too. */
				<Badge variant="secondary" className="shrink-0">
					{/* The CODE is decorative to a screen reader — it hears the full
					 *  role from the sr-only span beside it, so the accessible name is
					 *  "Toastmaster" rather than "TD".
					 *
					 *  `aria-label` on the Badge itself is not an option, which is what
					 *  this shape exists to avoid: a Badge renders a bare <span>, which
					 *  maps to role `generic`, and ARIA 1.2 PROHIBITS `aria-label`
					 *  there, with honouring varying by screen reader. `title` stays on
					 *  the visible code, where a mouse user's pointer actually lands. */}
					<span aria-hidden title={role.roleName}>
						{role.code}
					</span>
					<span className="sr-only">{role.roleName}</span>
				</Badge>
			) : null}
		</div>
	);
}

/** Action line. Right-aligned, so every row in the rail shares one right
 *  edge — this is the alignment fix. Nothing is vertically centred across a
 *  variable-height block any more.
 *
 *  `gap-3`, not `gap-1.5`. The 6px inside `NudgeButtons` is justified by
 *  WhatsApp and Email being the same action on the same member — both fire
 *  `onContacted` — so a fat-finger between them costs nothing. The status
 *  control is neither: a slip from it onto Email writes `reached_out` AND
 *  throws the tablet into a mail client mid-meeting. The extra 6px is ~2%
 *  of a 340px rail. */
function PanelActionLine({ children }: { children: ReactNode }) {
	return <div className="flex items-center justify-end gap-3">{children}</div>;
}

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
	// Branches on the ANSWER as well as the slot, and still has to: keying on
	// `m.role` alone drafted "just confirming you're our Toastmaster" to someone
	// whose own row reads "Not coming" — the panel showing the officer a decline
	// and then handing them a message asserting acceptance.
	//
	// #663 shrank the case rather than removing it. A decline written from this
	// rail now FREES the roles the member held, so "declined but still holding a
	// slot" is no longer the normal outcome of the control right beside this
	// draft. It remains reachable three ways: a self-asserted Toastmaster's
	// decline, which records the rung and deliberately releases nothing; a row
	// written before #663; and the season grid's own `setAvailability`, which
	// writes the rung without releasing. So the branch stays, and so does the
	// re-ask copy — it is the honest draft for a member who is down as absent and
	// still on the programme.
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

	// The CONTROL is what carries assumed-ness, and it is the only thing that
	// does. The badge below answers ONE question — does this member hold a
	// role — and answers it identically for everyone who does. It used to answer
	// two: a filled `default` variant plus a Check made it the highest-contrast
	// element in the rail on exactly the rows `assumed` fires for, which is when
	// NOBODY REPLIED. So a check mark, the universal glyph for verified, was
	// decorating the one status nobody verified, while the control beside it was
	// muted to say "trust this least" — two emphasis signals pointing opposite
	// ways. The member who DID answer "Coming" while holding the same confirmed
	// slot got the quieter of the two.
	//
	// The qualifier lands here, where the muting already is, because muting alone
	// is not a message: a grey control says "less important", never "nobody said
	// this". Exhaustive over an assumed row — per the note above `storedStatus`
	// there is `null` or `reached_out` and nothing else — and deliberately NOT
	// stacked: "asked" already carries "nobody answered", so "Coming · assumed ·
	// asked" would say it twice and spend ~50px of a 340px rail doing so.
	const qualifier = alsoAsked ? ASKED_WORD : m.assumed ? ASSUMED_WORD : null;

	// Derived ONCE and used for both the visible label and the announced name, so
	// the two cannot disagree about what this row says. The visible suffix uses
	// the counts line's separator; the announced one spells it out, because "·"
	// is not read aloud.
	const statusLabel = m.status ? RUNG_LABELS[m.status] : "Ask";
	const visibleLabel = qualifier
		? `${statusLabel} · ${qualifier}`
		: statusLabel;
	const statusAnnouncement = `${m.name} status: ${statusLabel}${
		m.assumed ? ` — ${ASSUMED_WORD}, role confirmed` : ""
	}${alsoAsked ? `, already ${ASKED_WORD}` : ""}`;

	return (
		<PanelRow>
			<PanelIdentityLine name={m.name} role={m.role} />
			<PanelActionLine>
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
						{/* A FIXED TRACK, and `justify-between` inside it, so the action column
						 *  has TWO hard vertical edges. `justify-end` on the line above flushes
						 *  only the RIGHT one, and this trigger is `whitespace-nowrap` with a
						 *  label running from "Ask" to "Coming · assumed" — so everything to its
						 *  left was pushed by that delta and the two icon buttons, the repeated
						 *  identical elements the eye tracks down a 40-row column, formed a
						 *  ragged edge jittering up to ~90px row to row. That traded a crooked
						 *  status column for a crooked action column.
						 *
						 *  `w-44` (11rem = 176px) is MEASURED against the widest label after the
						 *  badge fix above, not guessed:
						 *
						 *    "Coming · assumed" at 14px/500   Manrope       119.86px
						 *                                     DejaVu Sans   130.16px
						 *        (the widest common substitute while the webfont swaps in)
						 *    sm button chrome: px-2.5 (10+10) + border (1+1)
						 *                      + gap-1.5 (6) + size-3.5 chevron (14)  =  42px
						 *    worst intrinsic width            130.16 + 42 = 172.16px
						 *
						 *  176px clears that by 3.8px and clears the shipped Manrope by 14.1px.
						 *  And it fits: the rail's usable width is ~292px, the icon cluster is
						 *  32 + 6 + 32 = 70px, and the 12px `gap-3` above leaves 210px for this
						 *  track — 34px spare. */}
						<Button
							variant="outline"
							size="sm"
							disabled={locked || pending}
							className={cn(
								"w-44 justify-between",
								m.assumed &&
									"text-muted-foreground hover:text-muted-foreground",
							)}
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
							{/* No `opacity-60`. The glyph inherits `currentColor`, which on an
							 *  assumed row is `text-muted-foreground` (`--sea-ink-soft` #416166);
							 *  composited at 60% over the outline button's `bg-background`
							 *  (`--foam` #f3faf5) that is 2.66:1, under the 3:1 WCAG 1.4.11 requires
							 *  of a non-text UI indicator — and 3.69:1 even on answered rows. The
							 *  muted colour is already doing the de-emphasis; multiplying the two is
							 *  what crossed the threshold. Without it: ~4.4:1 muted, ~6.7:1 normal. */}
							<ChevronDown className="size-3.5" aria-hidden />
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
			</PanelActionLine>
		</PanelRow>
	);
}

/** The three attendance statuses as a menu, with whatever trigger the caller
 *  hands it. ONE copy, because both roll chip shapes now open it: the recorded
 *  chip is its own trigger, and a suggestion row's trigger is the small chevron
 *  button beside its one-tap commit (see `RollChip`). Duplicating the items was
 *  the alternative, and the items carry the `busy` gate below — a gate applied to
 *  one copy and not the other is invisible from the outside.
 *
 *  The TRIGGER is passed in rather than described by props, so each branch keeps
 *  its own size, classes and accessible name without this component growing a
 *  flag for each. */
function RollStatusMenu({
	memberId,
	busy,
	onSetAttendance,
	children,
}: {
	memberId: string;
	/** GLOBAL in-flight, not this row's — see the panel's `busy` prop doc. */
	busy: boolean;
	onSetAttendance: (memberId: string, status: AttendanceStatus) => void;
	/** The trigger. Rendered `asChild`, so it must be a single element. */
	children: ReactNode;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{ROLL_MENU.map((item) => (
					<DropdownMenuItem
						key={item.label}
						/* Gating the TRIGGER above does not close a menu that is ALREADY
						 *  open, so the items are a fourth control needing the same global
						 *  signal. Narrow but reachable, and reachable exactly in the drain
						 *  window: the officer opens this menu while everything is idle,
						 *  wifi returns, the auto-drain effect flips `draining`, and their
						 *  pick hits `mutate()`'s silent refusal — menu closes, chip keeps
						 *  its old value, nothing says why. `DropdownMenu` is modal by
						 *  default, so a competing USER write cannot start while it is open;
						 *  the drain is the only way in. Radix skips `onSelect` entirely for
						 *  a disabled item (`handleSelect` is guarded by `!disabled`), so
						 *  this is a real block, not a styling hint.
						 *
						 *  `busy` only — NOT `locked || pending`. Roll mode deliberately
						 *  ignores the lifecycle lock, and `pending` is this row's own
						 *  in-flight write, which already implies `busy`. */
						disabled={busy}
						onSelect={() => onSetAttendance(memberId, item.status)}
					>
						{item.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Roll mode's status chip (spec D2/D3). A SUGGESTION (from the plan, never a
 *  record — `buildRollPanel` guarantees the two are mutually exclusive)
 *  renders dashed with a trailing "?" and commits in ONE tap. A RECORDED status
 *  renders solid, like plan mode's rung. BOTH shapes open the same menu.
 *
 *  That last sentence is the fix, and it is a fix to the SPEC, which said the
 *  suggestion "commits in ONE tap and must NOT open a menu" and was enforced
 *  through four review rounds. It is right about the common case and wrong about
 *  what roll call is FOR: roll call records the EXCEPTIONS — "Jane said she was
 *  coming and is not in the room" — and a suggestion row offered the officer
 *  exactly one first action, `present`. Every member who answered "coming", which
 *  on a chased roster is most of them, was therefore the WORST-supported case:
 *  the only route to `absent` was to tap "Present?", write a false `present` into
 *  `meeting_attendance` (the table the minutes PDF and the emailed minutes
 *  print), wait out the round trip, then open the now-solid chip's menu and pick
 *  the truth. Two writes, the first one a falsehood. The surface roll mode
 *  replaced (`AttendanceSection`) mapped all three statuses and cost one tap for
 *  any outcome.
 *
 *  So the one-tap commit STAYS — it is the thing worth keeping, it was just never
 *  the only thing needed — and the menu sits beside it. The common case is still
 *  one tap; the exception is two (open, pick), the same cost as a recorded row
 *  and as plan mode. Do NOT collapse the pair back into a single menu-only
 *  trigger. */
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
	// One expression for every control on the row. It was written out twice and
	// would now be three times, which is three places for a gate to go missing —
	// and `disables EVERY control while a write is in flight` is a fix this branch
	// already had to make once.
	const disabled = locked || pending || busy;

	// Composed from CONTENT, never an `aria-label`, and the full reasoning is on
	// `AttendanceRow`'s trigger ~150 lines above — read that comment first. It
	// applied here verbatim and roll mode shipped the version it warns against:
	// `aria-label` OVERRIDES content, so `"${row.name} status"` meant the answer
	// itself — Present / Absent / Excused — reached no screen reader at all, on the
	// one surface whose entire job is recording it. An officer taking roll with a
	// screen reader heard "Jane Smith status, button" forty times.
	//
	// Worse than plan mode's version was, because BOTH branches carried the same
	// label: a suggestion and a record announced IDENTICALLY while doing opposite
	// things, and the trailing "?" is not announced either. Radix puts
	// `aria-haspopup`/`aria-expanded` on a menu trigger only, so the sole
	// discriminator was the ABSENCE of a popup hint — an AT user reaching for the
	// menu on a suggestion row silently recorded `present` instead. That is F1's
	// hazard without even a mis-tap.
	//
	// ONE `sr-only` span per control carrying the whole string, with the visible
	// label `aria-hidden` beside it. Not a prefix plus a plain label, for the
	// jsdom-vs-browser reason spelled out on `AttendanceRow`'s trigger: the
	// separator between sibling children is display-dependent, so a split name
	// gains its space in a real browser and not under the harness.
	const recordedLabel = row.status ? ROLL_LABELS[row.status] : "—";
	// "not recorded" rather than the em dash, which is not read aloud. Both
	// branches open with `"${row.name} status: "` so the two are comparable to
	// someone hearing them; what follows is what actually differs.
	const recordedAnnouncement = `${row.name} status: ${
		row.status ? ROLL_LABELS[row.status] : "not recorded"
	}`;

	if (row.status === null && row.suggestion) {
		const suggestion = row.suggestion;
		// Says all three things the visible chip says: nothing is recorded yet, the
		// plan's answer maps to this status, and TAPPING COMMITS IT. The last clause
		// is the one the dashed border and the "?" carry visually and nothing carried
		// otherwise — and it is what stops this reading like the menu trigger beside
		// it, whose name deliberately omits the word "status".
		const suggestionAnnouncement = `${row.name} status: not recorded — the plan suggests ${ROLL_LABELS[suggestion]}. Tap to record it.`;
		return (
			// The SAME `w-44` track a recorded row's trigger fills (the 176px is
			// measured — see `AttendanceRow`'s trigger), so the two row shapes share
			// the rail's one right edge and its one left edge. Split 32px for the
			// chevron trigger, 4px of `gap-1`, and `flex-1` (140px) for the commit,
			// whose widest label needs ~104px ("Excused?" plus the sm button's 26px of
			// chrome). Sizing the pair inside the existing track rather than widening
			// it is what keeps the icon cluster to its left from moving.
			<div className="flex w-44 items-center gap-1">
				<Button
					variant="outline"
					size="sm"
					className="flex-1 border-dashed"
					disabled={disabled}
					onClick={() => onSetAttendance(row.id, suggestion)}
				>
					<span className="sr-only">{suggestionAnnouncement}</span>
					<span aria-hidden>{ROLL_LABELS[suggestion]}?</span>
				</Button>
				<RollStatusMenu
					memberId={row.id}
					busy={busy}
					onSetAttendance={onSetAttendance}
				>
					<Button
						variant="outline"
						size="icon-sm"
						className="shrink-0"
						disabled={disabled}
					>
						{/* The accessible name is COMPOSED FROM CONTENT — an `sr-only`
						 *  span — never an `aria-label`, for the reason set out on
						 *  `AttendanceRow`'s trigger. There is no visible text to
						 *  override here, so this is the content. It deliberately does
						 *  NOT contain the word "status": the one-tap commit beside it is
						 *  this row's status control, and two controls whose names both
						 *  read "<name> status" is exactly the ambiguity that made the
						 *  old single label a hazard. */}
						<span className="sr-only">
							Record a different attendance for {row.name}
						</span>
						<ChevronDown className="size-3.5" aria-hidden />
					</Button>
				</RollStatusMenu>
			</div>
		);
	}

	return (
		<RollStatusMenu
			memberId={row.id}
			busy={busy}
			onSetAttendance={onSetAttendance}
		>
			{/* The SAME fixed track and `justify-between` as plan mode's trigger, for
			 *  the reason measured there: `justify-end` on the action line flushes the
			 *  right edge only, and a `whitespace-nowrap` label running "—" to
			 *  "Excused" pushed everything to its left by that delta — so the two icon
			 *  buttons, the repeated elements the eye tracks down a 40-row column,
			 *  formed a ragged edge. Roll mode had no track at all: the chip was a
			 *  direct child of a `flex flex-col` `<li>` and stretched the full width,
			 *  so the rail's one right edge held for the plan rows and not for these.
			 *  `w-44` is the number plan mode measured for a wider label set, which
			 *  this one fits inside — one track for both modes is the point. */}
			<Button
				variant="outline"
				size="sm"
				className="w-44 justify-between"
				disabled={disabled}
			>
				<span className="sr-only">{recordedAnnouncement}</span>
				<span aria-hidden>{recordedLabel}</span>
				{/* No `opacity-60`, for the WCAG 1.4.11 reason spelled out on plan
				 *  mode's chevron: the glyph inherits `currentColor` and compositing it
				 *  at 60% takes a non-text indicator under 3:1. */}
				<ChevronDown className="size-3.5" aria-hidden />
			</Button>
		</RollStatusMenu>
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
	 *  file" copy and misstate a member who does have one on file.
	 *
	 *  `row.departed` gets the same treatment below, for the same reason and
	 *  never as a `phone === null && email === null` check: that message is
	 *  TRUE and useful for an active member with nothing on file ("go add a
	 *  number"), and only wrong for someone who has left the club. */
	hideContact: boolean;
	pending: boolean;
	busy: boolean;
	onSetAttendance: (memberId: string, status: AttendanceStatus) => void;
}) {
	return (
		// The rail's row (v1.19.0.0, #594), SHARED as code rather than as a copied
		// class list — see `PanelRow` for what the copy had missed. Both modes now
		// render the same three components, so the row is one thing again: the
		// identity line with the name and the short role code, then the action line,
		// right-aligned on the rail's one right edge, holding the icon-only contact
		// drafts and the status control inside its fixed track.
		<PanelRow>
			<PanelIdentityLine name={row.name} role={row.role} />
			<PanelActionLine>
				{hideContact || row.departed ? null : (
					// `iconOnly`, which this row was missing. The prop's own doc says it
					// is opt-in because "only the 340px attendance rail needs the space
					// back" — and this IS that rail, so the words cost ~60px of a ~292px
					// column for an affordance the plan rows next to it render as glyphs.
					//
					// `arriving`, not `attendance`. This row renders during the meeting —
					// contact stays until the meeting is `completed` — and the
					// `attendance` copy is a pre-meeting ask: "are you able to make our
					// Tuesday 18 August meeting?" under the subject "Are you coming?",
					// drafted at 7:45pm from the room where that meeting is running. The
					// question a roll-call row actually wants is whether they are on
					// their way.
					<NudgeButtons
						mode="arriving"
						iconOnly
						name={row.name}
						preferredName={row.preferredName}
						phone={row.phone}
						email={row.email}
						meetingDate={meetingDate}
						shareUrl={shareUrl}
					/>
				)}
				<RollChip
					row={row}
					locked={locked}
					pending={pending}
					busy={busy}
					onSetAttendance={onSetAttendance}
				/>
			</PanelActionLine>
		</PanelRow>
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
	sync,
}: {
	mode: "plan" | "roll";
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
	/** Roll mode only. Recorded rows; ignored in plan mode. */
	attendance?: { memberId: string; status: AttendanceStatus }[];
	/** Optimistic overrides from the route, keyed by member. A key present with
	 *  value `null` means "optimistically cleared" — distinct from absent,
	 *  which means "no override". */
	rungOverride: Readonly<Record<string, PlanStatus | null>>;
	roleByMemberId: Readonly<Record<string, PanelRole>>;
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
	/**
	 * Roll mode only. The offline write-queue's sync lifecycle, straight off the
	 * meeting's ONE `useOfflineMinutes` instance (the route owns it — do not
	 * instantiate a second here).
	 *
	 * Not a nicety, and not a duplicate of the Minutes card's indicator. Since
	 * roll call moved here this is the only surface that records attendance, and
	 * the queue's only status display stayed in a card that is now read-only for
	 * attendance — on a phone, at the other end of the page. So an officer took
	 * roll offline, watched every chip move (the projection is faithful), closed
	 * the tab, and the drain only ever ran if someone reopened THAT meeting in
	 * THAT browser: the minutes PDF and the emailed minutes went out with the
	 * roll missing and nothing they looked at said so.
	 *
	 * ONE object rather than six same-typed props, because `draining` and
	 * `justSynced` are both booleans and a swap would type-check. Optional so
	 * plan mode's callers need no change — which means dropping it at the call
	 * site is silent, and `attendance-panel-wiring.guard.test.ts` is what
	 * watches for that.
	 */
	sync?: SyncStatusProps;
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

	// Hoisted out of the `roster.map` below, where it was a `plan.find` per row —
	// the one super-linear term on this render path, and recomputed every render:
	// 0.015ms at n=40, 2.535ms at n=1000, 50.420ms at n=5000. Clean quadratic.
	// Not a defect at club scale; it is simply the only line here that does not
	// scale. Same idiom `buildPlanPanel` reaches for one call later.
	const planByMember = new Map(plan.map((p) => [p.memberId, p.status]));

	// Apply the override BEFORE calling buildPlanPanel, so the sort and the
	// counts reflect the optimistic state too — otherwise a chip jumps to a new
	// bucket a beat after it is tapped, and the counts line disagrees with the
	// chips. `!== undefined` (not `??`) because a key present with value `null`
	// means "optimistically cleared", distinct from the key being absent — and
	// collapsing it into `??` alongside the Map above would silently turn an
	// optimistic CLEAR back into the server's old rung.
	// Shared by BOTH modes: roll mode reads this same plan as its suggestion
	// source, so the optimistic override applies there too. Note it reads the
	// raw rungs — `buildPlanPanel`'s `assumed` Coming (a confirmed role slot
	// standing in for an answer, v1.19.0.0) is derived INSIDE that function and
	// does not reach roll's suggestions. Deliberate for now, filed as a P1.
	const effectivePlan = roster
		.map((m) => ({
			memberId: m.id,
			status:
				rungOverride[m.id] !== undefined
					? rungOverride[m.id]
					: (planByMember.get(m.id) ?? null),
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
				plan: effectivePlan,
				roleByMemberId,
			})
		: null;
	const planPanel = roll
		? null
		: buildPlanPanel({ roster, plan: effectivePlan, roleByMemberId });
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
		// Gated on `locked` for the same reason the dropdown trigger is: this is a
		// WRITE (no answer → asked), it just happens to be triggered by tapping a
		// message draft rather than picking a rung. The dropdown was already gated and this path was not, and
		// the difference only becomes visible as a hole the moment the panel is
		// rendered in another phase. The draft itself still opens; a locked
		// meeting just stops recording against it.
		//
		// Gated on `pendingId` for the reason the trigger's `disabled` covers the
		// OTHER control: `pending` reaches the dropdown and nothing else. The two
		// draft links are bare anchors — no `disabled` attribute exists on an `<a>`
		// — so a fat-finger fired `onContacted` once per tap. Measured on a rendered
		// fixture: during ONE in-flight write the status control read
		// `disabled = true` while the WhatsApp anchor read `disabled = false`,
		// `aria-disabled = null`, and four taps produced four calls. Neither layer
		// below absorbs it — the route's `markAsked` resolves `current` from the
		// `rungOverride` captured at render, so same-tick taps all see `null`, and
		// the server's `setPlanStatus` MATCHES an existing `reached_out` row, so
		// `returning()` is non-empty and every duplicate lands another `plan_set` in
		// `activity_log`. Not corruption (`demoteFrom` still stops a late nudge
		// overwriting a real answer), but N requests, N router invalidates and N
		// duplicate feed rows.
		//
		// ANY in-flight write, not just this member's. `pendingId` is a single slot
		// by construction, so it cannot represent two concurrent writes: a second
		// row's `finally` clears the flag out from under the first. Blocking on the
		// flag being set at all keeps its meaning honest rather than claiming a
		// per-row precision the state does not have. The cost is bounded and
		// recoverable — a deliberate tap on ANOTHER row inside the same round trip
		// still OPENS its draft (the anchor is never disabled), it just records
		// nothing, and the officer can set "Asked" by hand or tap again.
		//
		// The anchors are deliberately NOT made to LOOK unavailable mid-flight. An
		// `<a>` here has two jobs and only one of them is the write: its primary job
		// is opening the draft, which stays valid and wanted throughout the window.
		// `pointer-events-none` would suppress the primary action to protect the
		// bookkeeping one this guard already protects, and a bare `aria-disabled`
		// would announce "unavailable" about a link that still works — the same
		// visible/announced drift the status control's composed name exists to
		// avoid, in the other direction.
		//
		// `writesLocked`, not raw `locked`: identical on this path (a PLAN rung,
		// only `AttendanceRow` wires `onContacted`), but reading the same value as
		// every other write here is what stops the two drifting if a roll row ever
		// grows one.
		if (writesLocked || pendingId) return;
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

	// At `lg` this card is the pinned rail (`club.$clubId.meeting.$meetingId`),
	// which caps its height — so the card fills that cap and its BODY scrolls,
	// leaving the header (title, counts, sync status) in place above the rows.
	// Below `lg` the card is a normal block in the page flow and none of it
	// applies: the page scrolls, so a scroller here would be a box inside a box.
	// The `lg:` prefixes are the coupling to that one caller, which is also the
	// only caller.
	return (
		<Card className="lg:min-h-0 lg:flex-1">
			<CardHeader className="shrink-0">
				<div className="flex items-center justify-between gap-2">
					<div className="min-w-0">
						<CardTitle>{roll ? "Attendance" : "Planned attendance"}</CardTitle>
						<span className="text-xs text-[var(--sea-ink-soft)]">
							{countsLine}
						</span>
						{/* In the HEADER, not with the rows: it has to stay visible
						 *  whatever the collapse does, and it belongs next to the counts
						 *  line it qualifies — the counts are the optimistic projection,
						 *  and this is what says whether the server has heard about them.
						 *  Roll mode only, since plan writes go straight to
						 *  `setPlannedAttendance` and never touch the offline queue.
						 *  `SyncStatus` renders nothing in the steady state, so there is
						 *  no empty row on the normal path. */}
						{roll && sync ? <SyncStatus {...sync} /> : null}
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
				<CardContent className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">
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
					</ul>
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

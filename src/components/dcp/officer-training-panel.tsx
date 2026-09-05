/**
 * The Club Officer Training panel on the DCP scoreboard (#531) — the surface
 * that turns goal 9 from a bare toggle into something that can warn a club
 * before a training window shuts.
 *
 * PRESENTATIONAL: every value arrives as a prop and every write leaves through a
 * callback, so the whole thing is mountable in jsdom. That is not a style
 * preference — a route cannot be mounted in vitest, so logic living in
 * `admin/dcp.tsx` would be covered by a source grep and nothing else, and
 * CLAUDE.md records two real bugs found by mutation review in exactly that
 * position. The DERIVATIONS stay in `#/lib/officer-training`; this file renders.
 */
import { AlertTriangle, Check, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	formatIsoDate,
	type IsoDate,
	isWindowOrderValid,
	TRAINABLE_OFFICER_POSITIONS,
	type TrainingPeriod,
	type TrainingPeriodTally,
	trainingPeriodLabel,
	untrainedSeats,
	WINDOW_ORDER_MESSAGE,
} from "#/lib/officer-training";
import { type OfficerPosition, officerPositionLabel } from "#/lib/officers";
import { cn } from "#/lib/utils";
import type { OfficerTrainingView } from "#/server/officer-training-logic";

export interface AddRecordRequest {
	membershipId: string;
	position: OfficerPosition;
	period: TrainingPeriod;
	trainedOn: IsoDate | null;
}

export interface SetWindowRequest {
	period: TrainingPeriod;
	startsOn: IsoDate;
	endsOn: IsoDate;
}

export interface OfficerTrainingPanelProps {
	view: OfficerTrainingView;
	/** Disables every control while a write is in flight. */
	busy?: boolean;
	onAddRecord: (request: AddRecordRequest) => void;
	onRemoveRecord: (recordId: string) => void;
	onSetWindow: (request: SetWindowRequest) => void;
	onResetWindow: (period: TrainingPeriod) => void;
}

// `max-w-full` matters at 375px: a 36-character member name rendered the select
// 309px wide inside a 301px content box, clipping its own dropdown arrow against
// the card's `overflow-hidden`.
const SELECT_CLASS =
	"h-9 max-w-full rounded-md border border-[var(--line)] bg-[var(--surface-strong)] px-3 text-sm font-medium outline-none focus-visible:border-[var(--lagoon-deep)]";

/**
 * How close to the deadline counts as urgent. Three weeks is the issue's own
 * framing ("the window closes in three weeks and you have two of four").
 */
const URGENT_DAYS = 21;

export function OfficerTrainingPanel({
	view,
	busy = false,
	onAddRecord,
	onRemoveRecord,
	onSetWindow,
	onResetWindow,
}: OfficerTrainingPanelProps) {
	return (
		<section aria-labelledby="cot-heading" className="space-y-3">
			<div>
				{/* h3, not h2: the page is h1 → h2 per DCP category, and this panel is
				    nested INSIDE the Training category's section. An h2 here made the
				    two siblings in heading navigation, so a screen-reader user heard
				    "Training" then "Club officer training" as peers when one contains
				    the other. */}
				<h3 id="cot-heading" className="text-sm font-bold tracking-[-0.01em]">
					Club officer training
				</h3>
				{/* The counting rule is stated HERE, beside the numbers it governs.
				    It used to sit below both period cards, and it used to describe a
				    DIFFERENT rule from the one the code ran — "four different people"
				    over a headline that counts roles. A club with a Secretary/Treasurer
				    double-hatter is exactly where the two diverge, so the sentence has
				    to sit next to the number it explains and has to say the same thing
				    the number does. */}
				<p className="mt-1 max-w-2xl text-xs text-[var(--sea-ink-soft)]">
					Goal 9 needs four officer <em>roles</em> trained in each training
					period, and Toastmasters credits one person per role — so this page
					counts <em>roles</em>, not heads. Someone holding two offices and
					trained for both covers two of the four; four people all trained as
					Secretary cover one. Record who attended and this page tells you how
					many more you need and how long the window is open.
				</p>
			</div>

			{view.periods.map((tally) => (
				<PeriodCard
					key={tally.period}
					tally={tally}
					view={view}
					busy={busy}
					onAddRecord={onAddRecord}
					onRemoveRecord={onRemoveRecord}
					onSetWindow={onSetWindow}
					onResetWindow={onResetWindow}
				/>
			))}

			<p className="max-w-2xl text-xs text-[var(--sea-ink-soft)]">
				Toastmasters, not GavelUp, decides who was trained — nothing here ticks
				goal 9 for you.
			</p>
		</section>
	);
}

// ---------------------------------------------------------------------------
// One period
// ---------------------------------------------------------------------------

function PeriodCard({
	tally,
	view,
	busy,
	onAddRecord,
	onRemoveRecord,
	onSetWindow,
	onResetWindow,
}: {
	tally: TrainingPeriodTally;
	view: OfficerTrainingView;
	busy: boolean;
} & Pick<
	OfficerTrainingPanelProps,
	"onAddRecord" | "onRemoveRecord" | "onSetWindow" | "onResetWindow"
>) {
	const records = view.records.filter((r) => r.period === tally.period);
	// Keyed on (member, OFFICE) inside the helper — the display grain, narrower
	// than the scoring grain, so a dual-office holder can be half done.
	const open = untrainedSeats(view.seats, view.records, tally.period);
	const focused = view.focus === tally.period;

	return (
		<div
			data-testid={`cot-period-${tally.period}`}
			className={cn(
				"overflow-hidden rounded-2xl border bg-[var(--surface-strong)]",
				focused ? "border-[var(--lagoon-deep)]" : "border-[var(--line)]",
			)}
		>
			<div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-sm font-semibold">
							{trainingPeriodLabel(tally.period)}
						</span>
						<PhaseBadge tally={tally} />
					</div>
					<div className="mt-1 text-xs text-[var(--sea-ink-soft)]">
						{formatIsoDate(tally.window.startsOn)} –{" "}
						{formatIsoDate(tally.window.endsOn)}
						{tally.windowIsDefault
							? " · Toastmasters' standard window"
							: " · your club's dates"}
					</div>
				</div>
				<div className="text-right">
					<div className="font-display text-2xl font-semibold leading-none">
						{tally.trained}
						<span className="text-lg text-[var(--sea-ink-soft)]">
							/{tally.required}
						</span>
					</div>
					<div
						className={cn(
							"mt-1 text-xs font-semibold",
							tally.met
								? "text-[var(--sea-ink-soft)]"
								: "text-[var(--warning-strong)]",
						)}
					>
						{/* "All four trained", not "Bar cleared": the rest of this page
						    says Met / Mark met / not met / goals met, and the other arm of
						    this very ternary says "officers needed". "Bar cleared" named
						    nothing else on screen, and it is the only place a club is told
						    it succeeded. */}
						{tally.met
							? `All ${tally.required} roles trained`
							: `${tally.shortfall} more ${tally.shortfall === 1 ? "role" : "roles"} needed`}
					</div>
				</div>
			</div>

			<TrainedList
				records={records}
				busy={busy}
				onRemoveRecord={onRemoveRecord}
			/>

			{open.length > 0 ? (
				<div className="border-b border-[var(--line)] px-5 py-3">
					<div className="text-xs font-bold uppercase tracking-[0.04em] text-[var(--sea-ink-soft)]">
						Not recorded yet
					</div>
					{/*
					 * `max-w-full whitespace-normal` on the badge because Badge ships
					 * `whitespace-nowrap w-fit shrink-0`, so a long name could neither
					 * wrap nor shrink and the card's `overflow-hidden` CLIPPED it with
					 * no ellipsis and no scroller. Measured at a 375px viewport (301px
					 * content box): "Christopher Vandenberghe-Whitmore · VP Public
					 * Relations" rendered 339.4px, right edge past the card at x=376.4.
					 */}
					<ul className="mt-1.5 flex flex-wrap gap-1.5">
						{open.map((seat) => (
							<li
								key={`${seat.membershipId}:${seat.position}`}
								className="min-w-0"
							>
								<Badge
									variant="outline"
									className="max-w-full whitespace-normal text-left font-normal"
								>
									{seat.name} · {officerPositionLabel(seat.position)}
								</Badge>
							</li>
						))}
					</ul>
				</div>
			) : null}

			{/* KEYED on the window, so switching program year remounts the form and
			    re-seeds its date. The date is state seeded once at mount (a
			    fresh-entry field, deliberately not a mirror — see WindowEditor), and
			    the year picker changes `defaultDate` without remounting. The June
			    banner tells the admin to switch years to record training, and the
			    first record made afterwards then carried the PREVIOUS year's date
			    and arrived flagged "outside this window" — the exact failure
			    `defaultDateFor` exists to prevent, reached by following the app's
			    own instruction. */}
			<AddRecordForm
				key={`${tally.window.startsOn}:${tally.window.endsOn}`}
				period={tally.period}
				roster={view.roster}
				seats={view.seats}
				defaultDate={defaultDateFor(tally, view.today)}
				busy={busy}
				onAddRecord={onAddRecord}
			/>

			<WindowEditor
				tally={tally}
				busy={busy}
				onSetWindow={onSetWindow}
				onResetWindow={onResetWindow}
			/>
		</div>
	);
}

/**
 * The date to pre-fill the add form with: today when the window is open,
 * otherwise the window's own last day. Pre-filling a date outside the period
 * would make the very first record the panel creates arrive already flagged.
 */
function defaultDateFor(tally: TrainingPeriodTally, today: IsoDate): IsoDate {
	return tally.phase === "open" ? today : tally.window.endsOn;
}

function PhaseBadge({ tally }: { tally: TrainingPeriodTally }) {
	if (tally.phase === "closed") {
		return (
			<Badge variant="outline" className="font-normal">
				Closed
			</Badge>
		);
	}
	if (tally.phase === "upcoming") {
		return (
			<Badge variant="outline" className="font-normal">
				Opens {formatIsoDate(tally.window.startsOn)}
			</Badge>
		);
	}
	const days = tally.daysUntilClose ?? 0;
	// Urgency is the whole point of the countdown: flagging the last three weeks
	// is what the issue's "discovers in March" club never had.
	const urgent = !tally.met && days <= URGENT_DAYS;
	const countdown =
		days === 0
			? "Closes today"
			: `Closes in ${days} ${days === 1 ? "day" : "days"}`;
	return (
		<Badge
			className={cn(
				"gap-1 font-normal",
				// `text-[var(--on-accent-fill)]`, never `text-white`. Both of these
				// fills are light in BOTH themes, so white measured 3.2:1 / 2.0:1 on
				// the amber and 3.8:1 / 1.5:1 on the teal — all four under AA at the
				// 12px a Badge renders, and the two dark values are the label-on-fill
				// class recorded at #645. Dark ink is 4.6:1 at worst. See styles.css.
				"text-[var(--on-accent-fill)]",
				urgent ? "bg-[var(--warning-strong)]" : "bg-[var(--lagoon-deep)]",
			)}
		>
			{/* Urgency was carried by BACKGROUND COLOUR ALONE — the two arms rendered
			    identical text, so a colour-blind reader, a forced-colours reader and
			    anyone printing the page got no signal at all (WCAG 1.4.1). The icon
			    and the trailing words are the non-colour channel. */}
			{urgent ? <AlertTriangle className="size-3" aria-hidden /> : null}
			{urgent ? `${countdown} · act now` : countdown}
		</Badge>
	);
}

function TrainedList({
	records,
	busy,
	onRemoveRecord,
}: {
	records: OfficerTrainingView["records"];
	busy: boolean;
	onRemoveRecord: (recordId: string) => void;
}) {
	if (records.length === 0) {
		return (
			<p className="border-b border-[var(--line)] px-5 py-3 text-xs text-[var(--sea-ink-soft)]">
				Nobody recorded for this period yet.
			</p>
		);
	}
	return (
		<ul className="border-b border-[var(--line)]">
			{/*
			 * Each row is TWO flex children, not eight: the details wrap inside their
			 * own `min-w-0 flex-1` group and the delete button stays pinned to the
			 * first line. With every span a direct child of the row, `ml-auto` put the
			 * button on whichever wrapped line it landed on — at 390px that was a
			 * second line for the longer names, giving the list ragged row heights.
			 */}
			{records.map((r) => (
				<li key={r.id} className="flex items-start gap-2 px-5 py-2 text-sm">
					<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
						<Check
							className="size-3.5 shrink-0 text-[var(--lagoon-deep)]"
							aria-hidden
						/>
						<span className="font-medium">{r.memberName}</span>
						<span className="text-xs text-[var(--sea-ink-soft)]">
							{officerPositionLabel(r.position)}
						</span>
						{r.trainedOn ? (
							<span className="text-xs text-[var(--sea-ink-soft)]">
								{formatIsoDate(r.trainedOn)}
							</span>
						) : (
							<span className="text-xs italic text-[var(--sea-ink-soft)]">
								date not recorded
							</span>
						)}
						{r.outsideWindow ? (
							<Badge
								variant="outline"
								className="gap-1 border-[var(--warning-strong)] font-normal text-[var(--warning-strong)]"
							>
								<AlertTriangle className="size-3" aria-hidden />
								outside this window
							</Badge>
						) : null}
						{r.counts ? null : (
							// Says WHY, and carries a title, because this badge renders
							// only for a row the UI cannot create (the seam refuses
							// Immediate Past President and the picker never offers it) —
							// so its only reader is someone with no context for it, and a
							// bare "not counted" gave neither a reason nor a remedy.
							<Badge
								variant="outline"
								className="max-w-full whitespace-normal font-normal"
								title="Immediate Past President is not one of the seven offices Toastmasters counts for officer training."
							>
								not counted by Toastmasters
							</Badge>
						)}
					</div>
					<Button
						size="sm"
						variant="ghost"
						className="shrink-0"
						disabled={busy}
						// "Remove X as Secretary" is what a button that ENDED an officer
						// term would say; this deletes a training RECORD, and the button
						// is icon-only so its label is a screen reader's only cue.
						aria-label={`Remove ${r.memberName}'s ${officerPositionLabel(r.position)} training record`}
						onClick={() => onRemoveRecord(r.id)}
					>
						<Trash2 className="size-3.5" aria-hidden />
					</Button>
				</li>
			))}
		</ul>
	);
}

// ---------------------------------------------------------------------------
// Add a record
// ---------------------------------------------------------------------------

function AddRecordForm({
	period,
	roster,
	seats,
	defaultDate,
	busy,
	onAddRecord,
}: {
	period: TrainingPeriod;
	roster: OfficerTrainingView["roster"];
	seats: OfficerTrainingView["seats"];
	defaultDate: IsoDate;
	busy: boolean;
	onAddRecord: (request: AddRecordRequest) => void;
}) {
	const [membershipId, setMembershipId] = useState("");
	const [position, setPosition] = useState<OfficerPosition | "">("");
	const [trainedOn, setTrainedOn] = useState<string>(defaultDate);

	// The offices this member currently holds come FIRST, then the rest of the
	// seven. All seven stay offered rather than being restricted to open terms: a
	// member can legitimately have been trained for an office they have since
	// handed on, and the officer whose term ended mid-window is the case that
	// makes the record worth keeping at all.
	const held = seats
		.filter((s) => s.membershipId === membershipId)
		.map((s) => s.position);
	const officeOptions = [
		...held,
		...TRAINABLE_OFFICER_POSITIONS.filter((p) => !held.includes(p)),
	];

	function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!membershipId || !position) return;
		onAddRecord({
			membershipId,
			position,
			period,
			// Empty means "we don't know the day" — a null column, never a sentinel
			// date some later predicate would read as real.
			trainedOn: trainedOn === "" ? null : trainedOn,
		});
		setMembershipId("");
		setPosition("");
	}

	const selectId = `cot-member-${period}`;
	const positionId = `cot-office-${period}`;
	const dateId = `cot-date-${period}`;

	return (
		<form
			onSubmit={submit}
			className="flex flex-wrap items-end gap-2 border-b border-[var(--line)] px-5 py-3"
		>
			<div className="space-y-1">
				<Label htmlFor={selectId} className="text-xs">
					Member
				</Label>
				<select
					id={selectId}
					className={SELECT_CLASS}
					value={membershipId}
					disabled={busy}
					onChange={(e) => {
						setMembershipId(e.target.value);
						setPosition("");
					}}
				>
					<option value="">Pick a member…</option>
					{roster.map((m) => (
						<option key={m.membershipId} value={m.membershipId}>
							{m.name}
						</option>
					))}
				</select>
			</div>
			<div className="space-y-1">
				<Label htmlFor={positionId} className="text-xs">
					Trained as
				</Label>
				<select
					id={positionId}
					className={SELECT_CLASS}
					value={position}
					disabled={busy || membershipId === ""}
					onChange={(e) => setPosition(e.target.value as OfficerPosition)}
				>
					<option value="">Pick an office…</option>
					{officeOptions.map((p) => (
						<option key={p} value={p}>
							{officerPositionLabel(p)}
						</option>
					))}
				</select>
			</div>
			<div className="space-y-1">
				<Label htmlFor={dateId} className="text-xs">
					Date (optional)
				</Label>
				<Input
					id={dateId}
					type="date"
					className="h-9 w-40"
					value={trainedOn}
					disabled={busy}
					onChange={(e) => setTrainedOn(e.target.value)}
				/>
			</div>
			<Button
				type="submit"
				size="sm"
				disabled={busy || !membershipId || !position}
			>
				<Plus className="size-3.5" aria-hidden />
				Record training
			</Button>
		</form>
	);
}

// ---------------------------------------------------------------------------
// Edit the window
// ---------------------------------------------------------------------------

function WindowEditor({
	tally,
	busy,
	onSetWindow,
	onResetWindow,
}: {
	tally: TrainingPeriodTally;
	busy: boolean;
} & Pick<OfficerTrainingPanelProps, "onSetWindow" | "onResetWindow">) {
	const [startsOn, setStartsOn] = useState(tally.window.startsOn);
	const [endsOn, setEndsOn] = useState(tally.window.endsOn);
	const [open, setOpen] = useState(false);
	const editorId = `cot-window-editor-${tally.period}`;

	// These two inputs MIRROR stored state, so they must re-sync when it changes.
	// Without this the editor stayed open after a save or a reset holding the OLD
	// dates while the header above it showed the new ones — and `changed` was then
	// true, so "Save dates" was live and one stray click silently re-applied the
	// override the admin had just cleared. Found in a browser, not by a test: it
	// needs a real write to land while the editor is open. Same fix and same
	// reason as `BaseCard` in `_authed/admin/dcp.tsx`, which mirrors
	// `baseMemberCount` and syncs it exactly this way.
	//
	// Keyed on the VALUES, not the object, so a re-render that hands over an
	// equal-but-new `window` does not clobber what the admin is mid-way through
	// typing. `AddRecordForm`'s date field deliberately does NOT do this: it is a
	// fresh-entry field with a seeded default, not a mirror, and re-syncing it
	// would discard a date the admin had typed.
	useEffect(() => {
		setStartsOn(tally.window.startsOn);
		setEndsOn(tally.window.endsOn);
	}, [tally.window.startsOn, tally.window.endsOn]);

	// `isWindowOrderValid`, not a local `endsOn < startsOn`: that predicate calls
	// an EMPTY start valid, because `"2026-08-31" < ""` is false. Clearing the
	// Opens field therefore left Save live on a request the server always
	// rejects — with a raw `ZodError` JSON array as the toast. Clearing Closes
	// happened to behave, which is what made it look like a working check.
	const invalid = !isWindowOrderValid(startsOn, endsOn);
	const changed =
		startsOn !== tally.window.startsOn || endsOn !== tally.window.endsOn;

	if (!open) {
		return (
			<div className="px-5 py-2.5">
				<Button
					size="sm"
					variant="ghost"
					disabled={busy}
					aria-expanded={false}
					aria-controls={editorId}
					onClick={() => setOpen(true)}
				>
					Edit these dates
				</Button>
			</div>
		);
	}

	return (
		<div id={editorId} className="flex flex-wrap items-end gap-2 px-5 py-3">
			<div className="space-y-1">
				<Label htmlFor={`cot-start-${tally.period}`} className="text-xs">
					Opens
				</Label>
				<Input
					id={`cot-start-${tally.period}`}
					type="date"
					className="h-9 w-40"
					value={startsOn}
					disabled={busy}
					onChange={(e) => setStartsOn(e.target.value)}
				/>
			</div>
			<div className="space-y-1">
				<Label htmlFor={`cot-end-${tally.period}`} className="text-xs">
					Closes
				</Label>
				<Input
					id={`cot-end-${tally.period}`}
					type="date"
					className="h-9 w-40"
					value={endsOn}
					disabled={busy}
					onChange={(e) => setEndsOn(e.target.value)}
				/>
			</div>
			{/* Each write CLOSES the editor. `setOpen(false)` appeared nowhere
			    before, so once opened the form stayed on both period cards for the
			    life of the page — including after a successful save, where the
			    button that would collapse it is the very element the form replaced.
			    Collapsing on write is also what makes the value re-sync above
			    visible as confirmation rather than as a silent swap. */}
			<Button
				size="sm"
				disabled={busy || invalid || !changed}
				onClick={() => {
					onSetWindow({ period: tally.period, startsOn, endsOn });
					setOpen(false);
				}}
			>
				Save dates
			</Button>
			{tally.windowIsDefault ? null : (
				<Button
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() => {
						onResetWindow(tally.period);
						setOpen(false);
					}}
				>
					<RotateCcw className="size-3.5" aria-hidden />
					Use Toastmasters' dates
				</Button>
			)}
			<Button
				size="sm"
				variant="ghost"
				disabled={busy}
				onClick={() => {
					// Discard the edit as well as collapsing, so reopening starts from
					// what is stored rather than from a half-typed abandoned value.
					setStartsOn(tally.window.startsOn);
					setEndsOn(tally.window.endsOn);
					setOpen(false);
				}}
			>
				Cancel
			</Button>
			{invalid ? (
				<p className="text-xs text-[var(--warning-strong)]">
					{WINDOW_ORDER_MESSAGE}
				</p>
			) : null}
		</div>
	);
}

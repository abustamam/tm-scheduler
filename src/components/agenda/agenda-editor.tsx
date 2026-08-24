import {
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	Loader2,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import {
	type BudgetEntry,
	type DisplayBand,
	foldRepeatTail,
	groupIntoBands,
	summarizeAgenda,
} from "#/lib/agenda-budget";
import {
	applyFlex,
	flexBannerMessage,
	TABLE_TOPICS_MAX,
	TABLE_TOPICS_MIN,
} from "#/lib/agenda-runsheet";
import { buildTemplateRowsWithSource } from "#/lib/agenda-template-rows";
import { buildTimeline } from "#/lib/agenda-timing";
import {
	MAX_BEAT_MINUTES,
	MAX_ROLE_REPEAT_SLOTS,
	MAX_TEMPLATE_DETAIL_CHARS,
	MAX_TEMPLATE_LABEL_CHARS,
} from "#/lib/meeting-template-limits";
import type {
	AgendaDraft,
	AgendaDraftRole,
	AgendaDraftRow,
	ReleasedHolder,
} from "#/server/meeting-agenda-edit";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : "Something went wrong.";
}

/** "Ada Lovelace and Grace Hopper" — the THIRD verbatim copy of this join, with
 *  `MeetingTemplateDialog`'s `joinNames` and `agenda-template-rows.ts`'s
 *  `joinHolders`. Left duplicated on purpose: the two components are client-side
 *  and the third is a pure lib the renderer imports, so a shared home would mean
 *  a new module for six lines that have never disagreed. Counted here so the
 *  next person weighing the extraction knows it is three, not two. */
function joinNames(names: string[]): string {
	return new Intl.ListFormat("en", {
		style: "long",
		type: "conjunction",
	}).format(names);
}

/** The one message `removeAgendaRole` throws for a key its own template no
 *  longer declares — reachable a second time from a double-clicked confirm,
 *  or from a role another tab already removed. The role is gone either way,
 *  so this is treated as success rather than surfaced as a raw server error
 *  to an officer who did nothing wrong. */
function isRoleAlreadyGone(err: unknown): boolean {
	return (
		err instanceof Error &&
		/is not a role this template declares/.test(err.message)
	);
}

const CATEGORY_LABELS: Record<AgendaDraftRole["category"], string> = {
	leadership: "Leadership",
	speaker: "Speaker",
	evaluator: "Evaluator",
	functionary: "Functionary",
};

export type RowPatch = Partial<
	Pick<
		AgendaDraftRow,
		| "label"
		| "detail"
		| "minutes"
		| "roleKey"
		| "repeatsRoleKey"
		| "flex"
		| "markGreen"
		| "markYellow"
		| "markRed"
	>
>;

export interface NewAgendaRole {
	name: string;
	category: AgendaDraftRole["category"];
	defaultCount: number;
	isSpeakerRole: boolean;
}

export interface AgendaEditorProps {
	draft: AgendaDraft;
	/** Returns the CREATED row. The server fn already did; the prop type
	 *  discarded it. Undo needs the new id to restore the deleted row's fields
	 *  onto it. */
	onAddRow: (
		afterRowId: string | null,
		kind: AgendaDraftRow["kind"],
	) => Promise<AgendaDraftRow>;
	onUpdateRow: (rowId: string, patch: RowPatch) => Promise<unknown>;
	onRemoveRow: (rowId: string) => Promise<unknown>;
	onMoveRow: (rowId: string, direction: "up" | "down") => Promise<unknown>;
	onAddRole: (role: NewAgendaRole) => Promise<unknown>;
	planRoleRemoval: (roleKey: string) => Promise<ReleasedHolder[]>;
	onRemoveRole: (roleKey: string) => Promise<unknown>;
}

/** Runs a mutation and toasts on failure — the shared shape every button below
 *  uses so a rejected server fn never becomes an unhandled promise.
 *
 *  Returns whether the save LANDED, which the text/number fields need and the
 *  buttons ignore. A rejected save leaves an input showing a value the server
 *  does not hold: `router.invalidate()` re-renders the same `row.id`, so React
 *  keeps the existing state and nothing re-seeds it — and the next blur is a
 *  no-op, because the field already agrees with itself. */
async function runAction(action: () => Promise<unknown>): Promise<boolean> {
	try {
		await action();
		return true;
	} catch (err) {
		toast.error(errMessage(err));
		return false;
	}
}

/**
 * The per-meeting agenda editor. Presentational: every mutation is a prop, so
 * the whole component is reachable from vitest without the Start runtime —
 * the same shape `MeetingTemplateDialog` uses. The route wires the props to
 * the Task 6-8 server fns and calls `router.invalidate()` after each.
 */
/**
 * The editor's clock, computed the way the PRINT route computes it — the same
 * three pure functions in the same order (`print.tsx:154-168`), never a second
 * derivation.
 *
 * A parity test cannot see a defect present on both sides, so the fix is to
 * have only ONE side: these three are the same functions the printed agenda,
 * the meeting page and the projected deck all resolve through. The editor is a
 * fourth caller, not a second implementation.
 *
 * Runs against `localRows` rather than `draft.rows` so the clock moves as the
 * officer types, before any save. That is the whole feature — the previous
 * editor could change a duration and tell you nothing about what it did.
 */
function useAgendaModel(draft: AgendaDraft, localRows: AgendaDraftRow[]) {
	return useMemo(() => {
		// `AgendaDraftRow` and `TemplateBeatRow` are field-for-field identical
		// (id, sortOrder, kind, label, detail, minutes, roleKey, repeatsRoleKey,
		// flex, three marks), so this passes straight through with no mapping. If
		// typecheck ever disagrees the two types have drifted — reconcile them
		// rather than papering over it with a spread.
		const sourced = buildTemplateRowsWithSource(
			localRows,
			draft.roles,
			draft.slots,
		);
		const flexed = applyFlex(
			sourced.map((e) => e.row),
			draft.lengthMinutes,
		);
		const timed = buildTimeline(flexed.rows, draft.scheduledAt, draft.timeZone);
		const entries: BudgetEntry[] = timed.map((row, i) => ({
			row,
			beatId: sourced[i]?.beatId ?? "",
			iteration: sourced[i]?.iteration ?? 0,
			iterationCount: sourced[i]?.iterationCount ?? 1,
		}));
		return {
			entries,
			bands: groupIntoBands(entries),
			budget: summarizeAgenda(
				entries,
				draft.lengthMinutes,
				draft.scheduledAt,
				draft.timeZone,
			),
			// Reused, never re-written: the print preview shows this same sentence
			// for this same meeting, and two surfaces contradicting each other
			// about whether an agenda runs long is worse than neither speaking.
			advice: flexBannerMessage(flexed),
		};
	}, [draft, localRows]);
}

/** `+2` / `85 under` / `on time` — the delta as a phrase. Never suppressed
 *  inside the ±2 deadband: `applyFlex`'s `status` collapses to "exact" there,
 *  which is right for a banner and wrong for a readout (D5). */
function deltaPhrase(deltaMinutes: number): string {
	if (deltaMinutes === 0) return "on time";
	return deltaMinutes > 0 ? `${deltaMinutes} over` : `${-deltaMinutes} under`;
}

export function AgendaEditor({
	draft,
	onAddRow,
	onUpdateRow,
	onRemoveRow,
	onMoveRow,
	onAddRole,
	planRoleRemoval,
	onRemoveRole,
}: AgendaEditorProps) {
	const { editable, roles } = draft;

	// The draft is the server's truth; this is what the officer is typing. Keyed
	// on `draft.rows` identity so a structural mutation (add/remove/move, which
	// DO invalidate the route) re-seeds, while a pure edit does not.
	const [localRows, setLocalRows] = useState(draft.rows);
	const seededFrom = useRef(draft.rows);
	if (seededFrom.current !== draft.rows) {
		seededFrom.current = draft.rows;
		setLocalRows(draft.rows);
	}

	const { entries, bands, budget, advice } = useAgendaModel(draft, localRows);
	// Iterations 2..N of a repeat block fold into ONE summary line — see
	// `foldRepeatTail`. Six near-identical rows on a four-contestant contest
	// say nothing the first two do not, and push the closing section below the
	// fold.
	const display = useMemo(() => foldRepeatTail(bands), [bands]);
	// A row's position in the FULL expanded agenda, which is what the start-time
	// test hooks and the move-button bounds are stated against. Folding changes
	// what is drawn, never what the agenda is.
	const indexOf = (entry: BudgetEntry) => entries.indexOf(entry);
	// Read off the SERVER's rows, not the local copy: `flex` is only ever changed
	// by a button that round-trips, so there is no local edit to reflect.
	const someRowStretches = draft.rows.some((r) => r.flex);
	/** The stored row before this one in SORT order — undo's insertion point.
	 *  Taken from `draft.rows` rather than the rendered entries, because a
	 *  repeat block emits several entries from one stored row and only the
	 *  stored order can say what a row goes back after. */
	const previousRowIdOf = (rowId: string): string | null => {
		const at = draft.rows.findIndex((r) => r.id === rowId);
		return at > 0 ? (draft.rows[at - 1]?.id ?? null) : null;
	};
	/** When a folded block actually ENDS: the start of the row after it, or the
	 *  agenda's end if it is the last thing on the sheet. The band itself only
	 *  knows its last row's START (see `EditorBand.lastRowStartsAt`) — a span
	 *  printed from that stops one row short and reads as a rounding error. */
	const endOfBand = (band: Extract<DisplayBand, { kind: "repeatTail" }>) => {
		const lastEntry = band.bands.at(-1)?.entries.at(-1);
		if (!lastEntry) return band.startsAt;
		return entries[entries.indexOf(lastEntry) + 1]?.row.time ?? budget.endsAt;
	};

	/** Patch one row locally so the clock moves now; the server call follows on
	 *  blur. */
	function patchLocal(rowId: string, patch: RowPatch) {
		setLocalRows((prev) =>
			prev.map((r) => (r.id === rowId ? { ...r, ...patch } : r)),
		);
	}

	// Section subtotals are positional: the Nth section row on screen takes the
	// Nth subtotal. `summarizeAgenda` walks the same rows in the same order.
	let sectionSeen = -1;

	return (
		<div className="flex flex-col gap-6">
			{!editable ? (
				<p className="rounded-md border border-dashed p-3 text-muted-foreground text-sm">
					This meeting's agenda is read-only now — it already happened, or was
					cancelled.
				</p>
			) : null}

			<div className="overflow-x-auto">
				<table className="w-full border-collapse text-sm">
					<thead>
						<tr className="border-b text-left text-muted-foreground text-xs uppercase tracking-wide">
							<th scope="col" className="w-16 py-2 font-medium">
								Start
							</th>
							<th scope="col" className="py-2 font-medium">
								Activity
							</th>
							<th scope="col" className="w-40 py-2 font-medium">
								Who
							</th>
							<th scope="col" className="w-20 py-2 text-right font-medium">
								Min
							</th>
							<th scope="col" className="w-10 py-2">
								<span className="sr-only">Row actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{display.map((band) => {
							if (band.kind === "repeatTail") {
								return (
									<RepeatTailRow
										key={`tail-${band.bands[0]?.entries[0]?.beatId}-${band.fromIteration}`}
										band={band}
										indexOf={indexOf}
										label={repeatLabel(band, draft)}
										endsAt={endOfBand(band)}
									/>
								);
							}
							const bandEntries: BudgetEntry[] =
								band.kind === "iteration" ? band.band.entries : [band.entry];
							return bandEntries.map((entry) => {
								// The SERVER's row, deliberately — not the locally patched one.
								// Every `commit*` asks "did this change?" by comparing the
								// field against `row`, and against a locally patched row that
								// question is always No: the patch already moved it, so the
								// save short-circuits and the officer's edit is never sent.
								// The local copy exists to move the CLOCK (`entry`); the
								// server copy is what an edit is measured against and what
								// `reseed()` restores.
								const row = draft.rows.find((r) => r.id === entry.beatId);
								if (!row) return null;
								if (row.kind === "section") sectionSeen += 1;
								const index = indexOf(entry);
								return (
									<AgendaTableRow
										key={`${entry.beatId}-${entry.iteration}`}
										index={index}
										entry={entry}
										row={row}
										roles={roles}
										editable={editable}
										isFirst={index === 0}
										isLast={index === entries.length - 1}
										sectionMinutes={
											row.kind === "section"
												? (budget.sections[sectionSeen]?.minutes ?? 0)
												: null
										}
										sectionIndex={row.kind === "section" ? sectionSeen : null}
										someRowStretches={someRowStretches}
										previousRowId={previousRowIdOf(row.id)}
										onPatchLocal={patchLocal}
										onAddRow={onAddRow}
										onUpdateRow={onUpdateRow}
										onRemoveRow={onRemoveRow}
										onMoveRow={onMoveRow}
									/>
								);
							});
						})}
					</tbody>
					<tfoot>
						<tr className="border-t-2">
							<td colSpan={5} className="py-2" data-testid="agenda-budget">
								<span className="font-medium">Ends {budget.endsAt}</span>
								<span className="text-muted-foreground">
									{" · "}
									{budget.totalMinutes} min · slot {budget.slotMinutes} min ·{" "}
								</span>
								<span
									className={
										budget.deltaMinutes > 0
											? "font-medium text-destructive"
											: ""
									}
								>
									{deltaPhrase(budget.deltaMinutes)}
								</span>
							</td>
						</tr>
						{advice ? (
							<tr>
								<td
									colSpan={5}
									className="pb-2 text-muted-foreground text-xs"
									data-testid="agenda-budget-advice"
								>
									{advice}
								</td>
							</tr>
						) : null}
					</tfoot>
				</table>
			</div>

			{editable ? (
				<div className="flex flex-wrap gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => runAction(() => onAddRow(null, "section"))}
					>
						Add row: Section
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => runAction(() => onAddRow(null, "role"))}
					>
						Add row: Role
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => runAction(() => onAddRow(null, "event"))}
					>
						Add row: Event
					</Button>
				</div>
			) : null}

			<RolesPanel
				roles={roles}
				editable={editable}
				onAddRole={onAddRole}
				planRoleRemoval={planRoleRemoval}
				onRemoveRole={onRemoveRole}
			/>
		</div>
	);
}

function parseIntOrNull(value: string): number | null {
	if (value.trim() === "") return null;
	const n = Number.parseInt(value, 10);
	return Number.isNaN(n) ? null : n;
}

/**
 * One rendered agenda row.
 *
 * FOUR columns carry the scannable facts — start, activity, who, minutes — and
 * the other six controls (note, role, per-holder, three timing marks, move,
 * delete) live behind a per-row disclosure. A row has ten controls and four
 * columns; widening the table until they all fit puts the running clock off the
 * left edge on a laptop, which is the one thing this redesign exists to show.
 *
 * `entry.row` is the DERIVED row (timed, and post-`applyFlex`); `row` is the
 * STORED beat an edit writes to. They are different objects on purpose: the
 * clock and the holder names come off the derivation, every control writes the
 * beat.
 */
function AgendaTableRow({
	index,
	entry,
	row,
	roles,
	editable,
	isFirst,
	isLast,
	sectionMinutes,
	sectionIndex,
	someRowStretches,
	previousRowId,
	onPatchLocal,
	onAddRow,
	onUpdateRow,
	onRemoveRow,
	onMoveRow,
}: {
	index: number;
	entry: BudgetEntry;
	row: AgendaDraftRow;
	roles: AgendaDraftRole[];
	editable: boolean;
	isFirst: boolean;
	isLast: boolean;
	/** Non-null only on a section row — that band's own total. */
	sectionMinutes: number | null;
	sectionIndex: number | null;
	/** Whether ANY row in the agenda already stretches — see the Min cell. */
	someRowStretches: boolean;
	/** The stored row immediately before this one, or null when it is first —
	 *  where undo puts it back. */
	previousRowId: string | null;
	onPatchLocal: (rowId: string, patch: RowPatch) => void;
	onAddRow: (
		afterRowId: string | null,
		kind: AgendaDraftRow["kind"],
	) => Promise<AgendaDraftRow>;
	onUpdateRow: (rowId: string, patch: RowPatch) => Promise<unknown>;
	onRemoveRow: (rowId: string) => Promise<unknown>;
	onMoveRow: (rowId: string, direction: "up" | "down") => Promise<unknown>;
}) {
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [label, setLabel] = useState(row.label);
	const [detail, setDetail] = useState(row.detail ?? "");
	const [minutes, setMinutes] = useState(String(row.minutes));
	const [markGreen, setMarkGreen] = useState(
		row.markGreen == null ? "" : String(row.markGreen),
	);
	const [markYellow, setMarkYellow] = useState(
		row.markYellow == null ? "" : String(row.markYellow),
	);
	const [markRed, setMarkRed] = useState(
		row.markRed == null ? "" : String(row.markRed),
	);

	/** What every control does when the server refuses the value: put the field
	 *  back to what the server still holds.
	 *
	 *  MORE load-bearing than it was under the card stack, not less. The route no
	 *  longer invalidates after a pure edit, so a rejected save produces no
	 *  re-render at all — without this the field goes on displaying a value that
	 *  was never saved, and looks saved. The local model is reset too, or the
	 *  clock would keep counting a duration the server rejected. */
	function reseed() {
		setLabel(row.label);
		setDetail(row.detail ?? "");
		setMinutes(String(row.minutes));
		setMarkGreen(row.markGreen == null ? "" : String(row.markGreen));
		setMarkYellow(row.markYellow == null ? "" : String(row.markYellow));
		setMarkRed(row.markRed == null ? "" : String(row.markRed));
		onPatchLocal(row.id, {
			label: row.label,
			detail: row.detail,
			minutes: row.minutes,
			markGreen: row.markGreen,
			markYellow: row.markYellow,
			markRed: row.markRed,
		});
	}

	async function commitLabel() {
		if (label === row.label) return;
		if (!(await runAction(() => onUpdateRow(row.id, { label })))) reseed();
	}
	async function commitDetail() {
		const next = detail === "" ? null : detail;
		if (next === row.detail) return;
		if (!(await runAction(() => onUpdateRow(row.id, { detail: next }))))
			reseed();
	}
	async function commitMinutes() {
		const parsed = Number.parseInt(minutes, 10);
		if (Number.isNaN(parsed)) {
			setMinutes(String(row.minutes));
			return;
		}
		if (parsed === row.minutes) return;
		if (!(await runAction(() => onUpdateRow(row.id, { minutes: parsed }))))
			reseed();
	}
	async function commitMarks() {
		const green = parseIntOrNull(markGreen);
		const yellow = parseIntOrNull(markYellow);
		const red = parseIntOrNull(markRed);
		if (
			green === row.markGreen &&
			yellow === row.markYellow &&
			red === row.markRed
		) {
			return;
		}
		const ok = await runAction(() =>
			onUpdateRow(row.id, {
				markGreen: green,
				markYellow: yellow,
				markRed: red,
			}),
		);
		if (!ok) reseed();
	}

	async function move(direction: "up" | "down") {
		setPending(true);
		await runAction(() => onMoveRow(row.id, direction));
		setPending(false);
	}

	async function remove() {
		// Snapshot BEFORE the delete: once the row is gone the server cannot tell
		// us what it held, and re-typing a label, its note, its minutes and three
		// timing marks is the cost of one misclick on a dense table.
		const snapshot = { ...row };
		setPending(true);
		const ok = await runAction(() => onRemoveRow(row.id));
		setPending(false);
		if (!ok) return;
		toast("Row deleted", {
			duration: 10_000,
			action: {
				label: "Undo",
				onClick: () => {
					void runAction(async () => {
						// Re-inserted after its ORIGINAL predecessor, not appended: a
						// row that comes back at the bottom of the agenda is not the
						// same row. `addAgendaRow` returns the created row, so no
						// re-read is needed to find it.
						const created = await onAddRow(previousRowId, snapshot.kind);
						await onUpdateRow(created.id, {
							label: snapshot.label,
							detail: snapshot.detail,
							minutes: snapshot.minutes,
							roleKey: snapshot.roleKey,
							repeatsRoleKey: snapshot.repeatsRoleKey,
							flex: snapshot.flex,
							markGreen: snapshot.markGreen,
							markYellow: snapshot.markYellow,
							markRed: snapshot.markRed,
						});
					});
				},
			},
		});
	}

	const isRoleRow = row.kind === "role";
	const perHolder =
		isRoleRow && row.roleKey != null && row.repeatsRoleKey === row.roleKey;

	// A section is a band, not an activity: it spans the table and carries its
	// own subtotal, which is the number that says WHERE an hour went.
	if (row.kind === "section") {
		return (
			<>
				<tr className="border-b bg-muted/40">
					<td
						className="py-2 font-medium text-muted-foreground text-xs"
						data-testid={`agenda-row-start-${index}`}
					>
						{entry.row.time}
					</td>
					<td colSpan={2} className="py-2">
						<Input
							aria-label="Row label"
							value={label}
							disabled={!editable}
							maxLength={MAX_TEMPLATE_LABEL_CHARS}
							className="h-7 border-0 bg-transparent px-0 font-semibold uppercase tracking-wide shadow-none focus-visible:bg-background focus-visible:px-2"
							onChange={(e) => {
								setLabel(e.target.value);
								onPatchLocal(row.id, { label: e.target.value });
							}}
							onBlur={() => void commitLabel()}
						/>
					</td>
					<td
						className="py-2 text-right font-semibold tabular-nums"
						data-testid={`agenda-section-total-${sectionIndex ?? 0}`}
					>
						{sectionMinutes ?? 0}
					</td>
					<td className="py-2 text-right">
						<RowActions
							open={open}
							setOpen={setOpen}
							editable={editable}
							pending={pending}
							isFirst={isFirst}
							isLast={isLast}
							move={move}
							remove={remove}
						/>
					</td>
				</tr>
				{open ? (
					<RowDetail
						row={row}
						roles={roles}
						editable={editable}
						perHolder={perHolder}
						isRoleRow={isRoleRow}
						detail={detail}
						setDetail={setDetail}
						commitDetail={commitDetail}
						markGreen={markGreen}
						setMarkGreen={setMarkGreen}
						markYellow={markYellow}
						setMarkYellow={setMarkYellow}
						markRed={markRed}
						setMarkRed={setMarkRed}
						commitMarks={commitMarks}
						onUpdateRow={onUpdateRow}
					/>
				) : null}
			</>
		);
	}

	return (
		<>
			<tr className="border-b">
				<td
					className="py-1.5 text-muted-foreground text-xs tabular-nums"
					data-testid={`agenda-row-start-${index}`}
				>
					{entry.row.time}
				</td>
				<td className="py-1.5">
					<Input
						aria-label="Row label"
						value={label}
						disabled={!editable}
						maxLength={MAX_TEMPLATE_LABEL_CHARS}
						className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:bg-background focus-visible:px-2"
						onChange={(e) => {
							setLabel(e.target.value);
							onPatchLocal(row.id, { label: e.target.value });
						}}
						onBlur={() => void commitLabel()}
					/>
				</td>
				<td className="py-1.5 text-muted-foreground text-xs">
					{/* The DERIVED holder, not a stored field: who holds a row comes
					    from the meeting's slots, which the officer changes on the
					    sign-up sheet rather than here. */}
					{entry.row.holder ?? ""}
				</td>
				<td
					className="py-1.5 text-right"
					data-testid={`agenda-row-minutes-${index}`}
				>
					{row.flex ? (
						// A row whose length is not the officer's to set. `applyFlex`
						// OVERWRITES this row's minutes to absorb the meeting's slack, so
						// rendering an input here would accept a value and discard it on
						// the next render — a control that changes nothing is worse than
						// no control. The number shown is the post-`applyFlex` one, which
						// is what will actually print.
						<span className="inline-flex items-center justify-end gap-1">
							<span className="tabular-nums">{entry.row.minutes}</span>
							<span className="text-muted-foreground text-xs">
								stretches {TABLE_TOPICS_MIN}–{TABLE_TOPICS_MAX}
							</span>
							{editable ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-6 px-1.5 text-xs"
									onClick={() =>
										void runAction(() => onUpdateRow(row.id, { flex: false }))
									}
								>
									Pin
								</Button>
							) : null}
						</span>
					) : (
						<span className="inline-flex items-center justify-end gap-1">
							<Input
								aria-label="Row minutes"
								type="number"
								min={0}
								max={MAX_BEAT_MINUTES}
								value={minutes}
								disabled={!editable}
								className="h-7 w-16 text-right tabular-nums"
								onChange={(e) => {
									setMinutes(e.target.value);
									const n = Number.parseInt(e.target.value, 10);
									// Only a parseable number moves the clock. A half-typed ""
									// or "-" leaves the last good value standing rather than
									// blanking the whole footer mid-keystroke.
									if (!Number.isNaN(n)) onPatchLocal(row.id, { minutes: n });
								}}
								onBlur={() => void commitMinutes()}
							/>
							{editable && !someRowStretches ? (
								// Offered only while NOTHING already stretches. `schema.ts`
								// states at most one flex beat per template and does not
								// enforce it; two would have `applyFlex` splitting the slack
								// between them, which is legal in the database and meaningless
								// on the page.
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-6 px-1.5 text-xs"
									onClick={() =>
										void runAction(() => onUpdateRow(row.id, { flex: true }))
									}
								>
									Make stretchy
								</Button>
							) : null}
						</span>
					)}
				</td>
				<td className="py-1.5 text-right">
					<RowActions
						open={open}
						setOpen={setOpen}
						editable={editable}
						pending={pending}
						isFirst={isFirst}
						isLast={isLast}
						move={move}
						remove={remove}
					/>
				</td>
			</tr>
			{open ? (
				<RowDetail
					row={row}
					roles={roles}
					editable={editable}
					perHolder={perHolder}
					isRoleRow={isRoleRow}
					detail={detail}
					setDetail={setDetail}
					commitDetail={commitDetail}
					markGreen={markGreen}
					setMarkGreen={setMarkGreen}
					markYellow={markYellow}
					setMarkYellow={setMarkYellow}
					markRed={markRed}
					setMarkRed={setMarkRed}
					commitMarks={commitMarks}
					onUpdateRow={onUpdateRow}
				/>
			) : null}
		</>
	);
}

/**
 * Name the thing a repeat block repeats over — "Contestant 2–4", not
 * "Iteration 2–4".
 *
 * Reads the CLUB's own role name (#445): a club that renamed the role sees its
 * own word, the same rule the printed sheet follows. Falls back to a neutral
 * phrase rather than inventing one when the block's role cannot be resolved,
 * which is only reachable on a corrupt template.
 */
function repeatLabel(
	band: Extract<DisplayBand, { kind: "repeatTail" }>,
	draft: AgendaDraft,
): string {
	const beatId = band.bands[0]?.entries[0]?.beatId;
	const row = draft.rows.find((r) => r.id === beatId);
	const role = draft.roles.find((x) => x.key === row?.repeatsRoleKey);
	const noun = role?.name ?? "Repeat";
	return `${noun} ${band.fromIteration}–${band.toIteration}`;
}

/**
 * Iterations 2..N of one repeat block, folded into a single line.
 *
 * READ-ONLY, and that is the design rather than a shortcut: every iteration
 * renders from the SAME stored beats, so an edit here would change all of them
 * — which is right for a contest (every contestant gets the same window) and
 * would be a lie to offer per-iteration. The editable copy is iteration 1,
 * directly above.
 *
 * The line carries the clock SPAN, so collapsing costs no timing information:
 * you can see contestant 4 starts at 7:34 without eight rows on screen.
 * Expanding shows every row, still read-only.
 */
function RepeatTailRow({
	band,
	indexOf,
	label,
	endsAt,
}: {
	band: Extract<DisplayBand, { kind: "repeatTail" }>;
	indexOf: (entry: BudgetEntry) => number;
	label: string;
	/** The true end, derived by the caller from the row after the band. */
	endsAt: string;
}) {
	const [open, setOpen] = useState(false);
	const rows = band.bands.flatMap((b) => b.entries);
	return (
		<>
			<tr className="border-b bg-muted/10" data-testid="agenda-band-rest">
				<td className="py-1.5 text-muted-foreground text-xs tabular-nums">
					{band.startsAt}
				</td>
				<td className="py-1.5 text-muted-foreground text-xs">
					<button
						type="button"
						className="inline-flex items-center gap-1 hover:underline"
						aria-expanded={open}
						onClick={() => setOpen(!open)}
					>
						{open ? (
							<ChevronDown className="size-3.5" aria-hidden="true" />
						) : (
							<ChevronRight className="size-3.5" aria-hidden="true" />
						)}
						{open ? `Hide ${label}` : `Show ${label}`}
					</button>
					<span className="ml-2">
						{band.startsAt}–{endsAt} · same as above
					</span>
				</td>
				<td className="py-1.5" />
				<td className="py-1.5 text-right text-muted-foreground tabular-nums">
					{band.minutes}
				</td>
				<td className="py-1.5" />
			</tr>
			{open
				? rows.map((entry) => (
						<tr
							key={`${entry.beatId}-${entry.iteration}`}
							className="border-b bg-muted/10 text-muted-foreground"
						>
							<td
								className="py-1 text-xs tabular-nums"
								data-testid={`agenda-row-start-${indexOf(entry)}`}
							>
								{entry.row.time}
							</td>
							<td className="py-1 pl-4 text-xs">
								{entry.row.roleLabel ?? entry.row.who}
							</td>
							<td className="py-1 text-xs">{entry.row.holder ?? ""}</td>
							<td className="py-1 text-right text-xs tabular-nums">
								{entry.row.minutes}
							</td>
							<td className="py-1" />
						</tr>
					))
				: null}
		</>
	);
}

/** The disclosure toggle plus move/delete — inline on every row, because
 *  reordering and trimming are what an officer does most and neither should
 *  cost an expand. */
function RowActions({
	open,
	setOpen,
	editable,
	pending,
	isFirst,
	isLast,
	move,
	remove,
}: {
	open: boolean;
	setOpen: (next: boolean) => void;
	editable: boolean;
	pending: boolean;
	isFirst: boolean;
	isLast: boolean;
	move: (direction: "up" | "down") => Promise<void>;
	remove: () => Promise<void>;
}) {
	return (
		<div className="flex items-center justify-end gap-0.5">
			{editable ? (
				<>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0"
						disabled={isFirst || pending}
						aria-label="Move up"
						onClick={() => move("up")}
					>
						<ArrowUp className="size-3.5" aria-hidden="true" />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0"
						disabled={isLast || pending}
						aria-label="Move down"
						onClick={() => move("down")}
					>
						<ArrowDown className="size-3.5" aria-hidden="true" />
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0"
						disabled={pending}
						aria-label="Remove row"
						onClick={remove}
					>
						<Trash2 className="size-3.5" aria-hidden="true" />
					</Button>
				</>
			) : null}
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-7 w-7 p-0"
				aria-label={open ? "Hide row details" : "Show row details"}
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				{open ? (
					<ChevronDown className="size-3.5" aria-hidden="true" />
				) : (
					<ChevronRight className="size-3.5" aria-hidden="true" />
				)}
			</Button>
		</div>
	);
}

/** Everything a row carries that the four columns do not: the note, the role
 *  binding, the per-holder flag and the timer card's three marks. */
function RowDetail({
	row,
	roles,
	editable,
	perHolder,
	isRoleRow,
	detail,
	setDetail,
	commitDetail,
	markGreen,
	setMarkGreen,
	markYellow,
	setMarkYellow,
	markRed,
	setMarkRed,
	commitMarks,
	onUpdateRow,
}: {
	row: AgendaDraftRow;
	roles: AgendaDraftRole[];
	editable: boolean;
	perHolder: boolean;
	isRoleRow: boolean;
	detail: string;
	setDetail: (next: string) => void;
	commitDetail: () => Promise<void>;
	markGreen: string;
	setMarkGreen: (next: string) => void;
	markYellow: string;
	setMarkYellow: (next: string) => void;
	markRed: string;
	setMarkRed: (next: string) => void;
	commitMarks: () => Promise<void>;
	onUpdateRow: (rowId: string, patch: RowPatch) => Promise<unknown>;
}) {
	return (
		<tr className="border-b bg-muted/20">
			<td />
			<td colSpan={4} className="py-3 pr-2">
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1">
						<Label htmlFor={`${row.id}-detail`}>Note</Label>
						<Input
							id={`${row.id}-detail`}
							aria-label="Row note"
							value={detail}
							disabled={!editable}
							maxLength={MAX_TEMPLATE_DETAIL_CHARS}
							onChange={(e) => setDetail(e.target.value)}
							onBlur={() => void commitDetail()}
						/>
					</div>

					{isRoleRow ? (
						<div className="flex flex-col gap-1">
							<Label htmlFor={`${row.id}-role`}>Role</Label>
							<select
								id={`${row.id}-role`}
								aria-label="Row role"
								className="h-9 rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
								value={row.roleKey ?? ""}
								disabled={!editable}
								// Both keys move TOGETHER. `repeatsRoleKey` is the
								// once/per-holder flag and a per-holder row must repeat over
								// the exact role it names (D4) — patching `roleKey` alone is
								// what let two clicks author a row that prints once per holder
								// of the OLD role, numbered and naming nobody, while this
								// editor's own label still read "One row". The server refuses
								// that merge now, so sending one key alone would simply fail
								// here.
								onChange={(e) => {
									const next = e.target.value === "" ? null : e.target.value;
									void runAction(() =>
										onUpdateRow(row.id, {
											roleKey: next,
											// "Nobody" clears both: with no role the checkbox
											// below is hidden, so a leftover repeat key would
											// have no UI path back out.
											repeatsRoleKey: perHolder ? next : null,
										}),
									);
								}}
							>
								<option value="">Nobody</option>
								{roles.map((r) => (
									<option key={r.key} value={r.key}>
										{r.name}
									</option>
								))}
							</select>
						</div>
					) : null}

					{isRoleRow && row.roleKey != null ? (
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={perHolder}
								disabled={!editable}
								onChange={(e) => {
									const checked = e.target.checked;
									void runAction(() =>
										onUpdateRow(row.id, {
											// The row's OWN key, never another role's — that is the
											// whole of the per-holder rule.
											repeatsRoleKey: checked ? row.roleKey : null,
										}),
									);
								}}
							/>
							{perHolder ? "One row per person holding this role" : "One row"}
						</label>
					) : null}

					<div className="grid grid-cols-3 gap-3">
						<div className="flex flex-col gap-1">
							<Label htmlFor={`${row.id}-green`}>Green at</Label>
							<Input
								id={`${row.id}-green`}
								aria-label="Green mark minute"
								type="number"
								min={0}
								max={MAX_BEAT_MINUTES}
								value={markGreen}
								disabled={!editable}
								onChange={(e) => setMarkGreen(e.target.value)}
								onBlur={() => void commitMarks()}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor={`${row.id}-yellow`}>Yellow at</Label>
							<Input
								id={`${row.id}-yellow`}
								aria-label="Yellow mark minute"
								type="number"
								min={0}
								max={MAX_BEAT_MINUTES}
								value={markYellow}
								disabled={!editable}
								onChange={(e) => setMarkYellow(e.target.value)}
								onBlur={() => void commitMarks()}
							/>
						</div>
						<div className="flex flex-col gap-1">
							<Label htmlFor={`${row.id}-red`}>Red at</Label>
							<Input
								id={`${row.id}-red`}
								aria-label="Red mark minute"
								type="number"
								min={0}
								max={MAX_BEAT_MINUTES}
								value={markRed}
								disabled={!editable}
								onChange={(e) => setMarkRed(e.target.value)}
								onBlur={() => void commitMarks()}
							/>
						</div>
					</div>
				</div>
			</td>
		</tr>
	);
}

/** What a role-removal confirmation is currently doing. `idle` renders no
 *  dialog at all. */
type RolePhase =
	| { kind: "idle" }
	| { kind: "checking"; role: AgendaDraftRole }
	| { kind: "confirming"; role: AgendaDraftRole; holders: ReleasedHolder[] }
	| { kind: "failed"; role: AgendaDraftRole; message: string };

function RolesPanel({
	roles,
	editable,
	onAddRole,
	planRoleRemoval,
	onRemoveRole,
}: {
	roles: AgendaDraftRole[];
	editable: boolean;
	onAddRole: (role: NewAgendaRole) => Promise<unknown>;
	planRoleRemoval: (roleKey: string) => Promise<ReleasedHolder[]>;
	onRemoveRole: (roleKey: string) => Promise<unknown>;
}) {
	const [phase, setPhase] = useState<RolePhase>({ kind: "idle" });
	const [confirmBusy, setConfirmBusy] = useState(false);
	const [name, setName] = useState("");
	const [category, setCategory] =
		useState<AgendaDraftRole["category"]>("functionary");
	const [defaultCount, setDefaultCount] = useState("1");
	const [isSpeakerRole, setIsSpeakerRole] = useState(false);
	const [addBusy, setAddBusy] = useState(false);

	/**
	 * Removing a role releases its slots, and a released holder cannot be
	 * notified afterwards (`notifications.slot_id` cascades away with the slot
	 * before the poller can see it) — so this leads with names, exactly like
	 * `MeetingTemplateDialog`, and only asks for a SECOND confirm when someone
	 * is actually affected. Nothing claimed → one click removes it.
	 */
	async function startRemove(role: AgendaDraftRole) {
		setPhase({ kind: "checking", role });
		try {
			const holders = await planRoleRemoval(role.key);
			if (holders.length === 0) {
				await onRemoveRole(role.key);
				setPhase({ kind: "idle" });
			} else {
				setPhase({ kind: "confirming", role, holders });
			}
		} catch (err) {
			setPhase({ kind: "failed", role, message: errMessage(err) });
		}
	}

	async function confirmRemove() {
		if (phase.kind !== "confirming") return;
		setConfirmBusy(true);
		try {
			await onRemoveRole(phase.role.key);
			setPhase({ kind: "idle" });
		} catch (err) {
			if (isRoleAlreadyGone(err)) {
				// A double-clicked confirm, or another tab already removed it —
				// the role is gone either way, so this reads as success rather
				// than surfacing the raw server message.
				toast.message(`"${phase.role.name}" was already removed.`);
				setPhase({ kind: "idle" });
			} else {
				setPhase({
					kind: "failed",
					role: phase.role,
					message: errMessage(err),
				});
			}
		} finally {
			setConfirmBusy(false);
		}
	}

	async function submitAddRole(e: React.FormEvent) {
		e.preventDefault();
		if (name.trim() === "") return;
		setAddBusy(true);
		try {
			await onAddRole({
				name: name.trim(),
				category,
				defaultCount: parseIntOrNull(defaultCount) ?? 0,
				isSpeakerRole,
			});
			setName("");
			setCategory("functionary");
			setDefaultCount("1");
			setIsSpeakerRole(false);
		} catch (err) {
			toast.error(errMessage(err));
		} finally {
			setAddBusy(false);
		}
	}

	const activeRole = phase.kind === "idle" ? null : phase.role;

	return (
		<div className="flex flex-col gap-3 rounded-lg border p-3">
			<h2 className="font-semibold text-sm">Roles</h2>
			<ul className="flex flex-col gap-1">
				{roles.map((role) => (
					<li
						key={role.key}
						className="flex items-center justify-between gap-2 text-sm"
					>
						<span>
							{role.name}{" "}
							<span className="text-muted-foreground text-xs">
								({CATEGORY_LABELS[role.category]}, {role.defaultCount}{" "}
								{role.defaultCount === 1 ? "slot" : "slots"})
							</span>
						</span>
						{editable ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								// One removal flow at a time: without this, a fast double
								// click fires `planRoleRemoval` twice, and on an unclaimed
								// role (the one-click path) that races two `onRemoveRole`
								// calls for the same key.
								disabled={phase.kind !== "idle"}
								onClick={() => startRemove(role)}
							>
								Remove {role.name}
							</Button>
						) : null}
					</li>
				))}
			</ul>

			{editable ? (
				<form
					className="flex flex-wrap items-end gap-2"
					onSubmit={submitAddRole}
				>
					<div className="flex flex-col gap-1">
						<Label htmlFor="new-role-name">New role name</Label>
						<Input
							id="new-role-name"
							value={name}
							maxLength={MAX_TEMPLATE_LABEL_CHARS}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="new-role-category">Category</Label>
						<select
							id="new-role-category"
							className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
							value={category}
							onChange={(e) =>
								setCategory(e.target.value as AgendaDraftRole["category"])
							}
						>
							{Object.entries(CATEGORY_LABELS).map(([value, label]) => (
								<option key={value} value={value}>
									{label}
								</option>
							))}
						</select>
					</div>
					<div className="flex flex-col gap-1">
						<Label htmlFor="new-role-count">Places</Label>
						<Input
							id="new-role-count"
							type="number"
							min={0}
							max={MAX_ROLE_REPEAT_SLOTS}
							value={defaultCount}
							onChange={(e) => setDefaultCount(e.target.value)}
							className="w-20"
						/>
					</div>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							checked={isSpeakerRole}
							onChange={(e) => setIsSpeakerRole(e.target.checked)}
						/>
						Speaking role
					</label>
					<Button
						type="submit"
						size="sm"
						disabled={addBusy || name.trim() === ""}
					>
						{addBusy ? (
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
						) : null}
						Add role
					</Button>
				</form>
			) : null}

			<Dialog
				open={phase.kind !== "idle"}
				onOpenChange={(open) => {
					if (!open) setPhase({ kind: "idle" });
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>Remove {activeRole?.name ?? "role"}?</DialogTitle>
					</DialogHeader>

					{phase.kind === "checking" ? (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Loader2 className="size-4 animate-spin" aria-hidden="true" />
							Checking who holds this role…
						</p>
					) : null}

					{phase.kind === "failed" ? (
						<p className="text-destructive text-sm">{phase.message}</p>
					) : null}

					{phase.kind === "confirming" ? (
						// Named once, in one sentence — every holder here loses the SAME
						// role (the one being removed), so a second per-holder list would
						// just repeat the role name back at them. Plain text, never a
						// link: the unlayered `a` rule in src/styles.css beats any
						// layered utility here.
						<div className="flex gap-2 text-sm">
							<TriangleAlert
								className="mt-0.5 size-4 shrink-0 text-destructive"
								aria-hidden="true"
							/>
							<div>
								<p className="font-medium">
									{joinNames(phase.holders.map((h) => h.name))} will lose{" "}
									{phase.role.name}.
								</p>
								<p className="text-muted-foreground">
									They won't be told automatically — message them after you
									remove it.
								</p>
							</div>
						</div>
					) : null}

					<DialogFooter className="gap-2">
						<Button
							type="button"
							variant="outline"
							disabled={confirmBusy}
							onClick={() => setPhase({ kind: "idle" })}
						>
							Cancel
						</Button>
						{phase.kind === "confirming" ? (
							<Button
								type="button"
								variant="destructive"
								disabled={confirmBusy}
								onClick={confirmRemove}
							>
								{confirmBusy ? (
									<Loader2 className="size-4 animate-spin" aria-hidden="true" />
								) : null}
								Remove anyway
							</Button>
						) : null}
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/**
 * The per-date diff on the agenda confirm page (#808).
 *
 * Presentational and router-free on purpose: it takes a view's lines and
 * blocking items and owns no server call, so a component test can render it and
 * assert what it draws without a router context or a mocked `#/db`.
 *
 * ## The horizontal scroller is load-bearing
 *
 * Six columns do not fit a phone, and up to 52 rows can land here at once. The
 * table sits in its own `overflow-x-auto` box with a `min-w` floor so the
 * columns keep their shape and the BOX scrolls — rather than the document,
 * which would take the heading, the summary and the Save button sideways with
 * it. `relative` is the other half: `sr-only` is `position:absolute`, and an
 * absolutely positioned descendant is laid out against its nearest POSITIONED
 * ancestor — the viewport, when there is none — so without it the hidden
 * "becomes" labels below sit at the table's right edge and drag the document
 * out with them. That is exactly the bug #806's confirm table shipped, measured
 * at 861px of document width on a 375px screen.
 * `src/components/agenda-plan/agenda-diff-geometry.test.ts` measures both
 * halves in a real browser, because jsdom performs no layout and every source
 * grep here is satisfied by a class string that lays out wrong.
 */
import { AGENDA_FIELD_LABEL } from "#/lib/agenda-upsert";
import type { AgendaPlanLine, AgendaWarning } from "#/server/agenda-plan";
import type { AgendaBlockingItem } from "#/server/agenda-plan-pending-logic";

const CELL = "px-3 py-2 align-top";
const HEAD =
	"px-3 py-2 text-left text-xs font-extrabold tracking-[0.06em] text-[var(--sea-ink-soft)] uppercase";

/** One sentence per warning, in the words an officer is thinking in. */
const WARNING_LABEL: Record<AgendaWarning, string> = {
	weekday_mismatch: "Not the club's usual weekday",
	meeting_cancelled: "This meeting is cancelled",
	time_ignored: "Keeping the time it already has",
};

export interface AgendaDiffTableProps {
	lines: AgendaPlanLine[];
	blocking: AgendaBlockingItem[];
	/** Provisional meeting numbers, keyed by line index. */
	meetingNumbers: Record<number, number | null>;
}

/**
 * Lines and blocked entries interleaved back into the order they were ASKED in.
 *
 * A blocked date produces no plan line, so rendering the two lists one after the
 * other would put the problems at the bottom in an order nobody chose. The
 * reader is checking this against a list of dates they just said out loud, and
 * `entryIndex` is the only thing that maps a row back to it.
 */
type Row =
	| { kind: "line"; index: number; line: AgendaPlanLine }
	| { kind: "blocked"; index: number; item: AgendaBlockingItem };

function rowsOf(props: AgendaDiffTableProps): Row[] {
	const rows: Row[] = props.lines.map((line) => ({
		kind: "line",
		index: line.index,
		line,
	}));
	for (const item of props.blocking) {
		// A call-wide item has no index and belongs above the table, not in it.
		if (item.entryIndex === null) continue;
		rows.push({ kind: "blocked", index: item.entryIndex, item });
	}
	return rows.sort((a, b) => a.index - b.index);
}

export function AgendaDiffTable(props: AgendaDiffTableProps) {
	const rows = rowsOf(props);

	return (
		<div className="relative w-full overflow-x-auto rounded-2xl border border-[var(--line)]">
			<table className="w-full min-w-[52rem] border-collapse text-sm">
				<thead>
					<tr className="border-b border-[var(--line)] bg-[var(--foam)]">
						<th className={HEAD}>Date</th>
						<th className={HEAD}>Time</th>
						<th className={HEAD}>Meeting</th>
						<th className={HEAD}>What happens</th>
						<th className={HEAD}>Changes</th>
						<th className={HEAD}>Notes</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) =>
						row.kind === "blocked" ? (
							<tr
								key={`blocked-${row.index}`}
								className="border-b border-[var(--line)] last:border-b-0"
								data-testid="agenda-diff-row"
							>
								<td className={`${CELL} whitespace-nowrap font-semibold`}>
									{row.item.date ?? "—"}
								</td>
								<td className={CELL}>—</td>
								<td className={CELL}>—</td>
								<td
									className={`${CELL} font-semibold text-[var(--ember,#a33)]`}
								>
									Can't do this one
								</td>
								<td className={CELL} colSpan={2}>
									{row.item.message}
								</td>
							</tr>
						) : (
							<tr
								key={`line-${row.index}`}
								className="border-b border-[var(--line)] last:border-b-0"
								data-testid="agenda-diff-row"
							>
								<td className={`${CELL} whitespace-nowrap font-semibold`}>
									{row.line.date}
									<span className="block text-xs font-normal text-[var(--sea-ink-soft)]">
										{row.line.weekday}
									</span>
								</td>
								<td className={`${CELL} whitespace-nowrap`}>{row.line.time}</td>
								<td className={`${CELL} whitespace-nowrap`}>
									{row.line.action === "update" &&
									props.meetingNumbers[row.line.index] != null ? (
										<>
											#{props.meetingNumbers[row.line.index]}
											<span className="block text-xs text-[var(--sea-ink-soft)]">
												provisional
											</span>
										</>
									) : (
										"—"
									)}
								</td>
								<td className={`${CELL} whitespace-nowrap font-semibold`}>
									{row.line.action === "create"
										? "New meeting"
										: row.line.changes.length === 0
											? "No change"
											: "Update"}
								</td>
								<td className={CELL}>
									{row.line.action === "create" ? (
										<CreateMeta
											meta={row.line.meta}
											location={row.line.location}
										/>
									) : row.line.changes.length === 0 ? (
										<span className="text-[var(--sea-ink-soft)]">
											Everything already matches
										</span>
									) : (
										<ul className="space-y-1">
											{row.line.changes.map((change) => (
												<li key={change.field}>
													<span className="font-semibold">
														{AGENDA_FIELD_LABEL[change.field]}
													</span>
													{": "}
													<Value value={change.from} />
													{/* The arrow reads as nothing to a screen reader,
													    so the word is there too — and being `sr-only`
													    it is `position:absolute`, which is what makes
													    the scroller's `relative` load-bearing. */}
													<span aria-hidden="true">{" → "}</span>
													<span className="sr-only"> becomes </span>
													<Value value={change.to} />
												</li>
											))}
										</ul>
									)}
								</td>
								<td className={CELL}>
									{row.line.warnings.length === 0 ? (
										<span className="text-[var(--sea-ink-soft)]">—</span>
									) : (
										<ul className="space-y-1">
											{row.line.warnings.map((warning) => (
												<li key={warning} className="text-xs">
													{WARNING_LABEL[warning]}
												</li>
											))}
										</ul>
									)}
								</td>
							</tr>
						),
					)}
				</tbody>
			</table>
		</div>
	);
}

/** A stored value, or a visible marker for "nothing there". */
function Value({ value }: { value: string | null }) {
	return value === null ? (
		<span className="text-[var(--sea-ink-soft)]">(empty)</span>
	) : (
		<span>{value}</span>
	);
}

/** What a create would write, listed the same way an update's diff is. */
function CreateMeta({
	meta,
	location,
}: {
	meta: {
		theme: string | null;
		wordOfTheDay: string | null;
		wodDefinition: string | null;
		wodExample: string | null;
	};
	location: string | null;
}) {
	const fields = [
		["theme", meta.theme],
		["wordOfTheDay", meta.wordOfTheDay],
		["wodDefinition", meta.wodDefinition],
		["wodExample", meta.wodExample],
		["location", location],
	] as const;
	const set = fields.filter(([, value]) => value !== null);
	if (set.length === 0) {
		return (
			<span className="text-[var(--sea-ink-soft)]">
				A blank meeting with the club's standard roles
			</span>
		);
	}
	return (
		<ul className="space-y-1">
			{set.map(([field, value]) => (
				<li key={field}>
					<span className="font-semibold">{AGENDA_FIELD_LABEL[field]}</span>
					{": "}
					{value}
				</li>
			))}
		</ul>
	);
}

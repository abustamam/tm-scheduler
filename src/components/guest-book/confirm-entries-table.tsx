/**
 * The editable table on the guest-book confirm page (#806).
 *
 * Presentational and router-free on purpose: it takes a view and an `onEdit`
 * callback and owns no server call, so a component test can render it and
 * assert the thing that matters — that every value here is UNMASKED, including
 * the ambiguity candidates — without a router context or a mocked `#/db`.
 *
 * ## Unmasked, deliberately
 *
 * The MCP tool masks everything it returns, because tool results are
 * transcribed into an LLM provider's conversation history. This page is the
 * opposite case: an authenticated admin of the club, checking what an LLM read
 * off handwriting against the paper page in front of them. A masked email is
 * unverifiable, which would make the whole feature pointless — and an email is
 * routinely the only thing distinguishing two guests with the same name, which
 * is exactly the question an `AMBIGUOUS_GUEST` line is asking.
 *
 * ## The horizontal scroller is load-bearing
 *
 * Six columns do not fit a phone, and a phone is where a club officer actually
 * transcribes a guest book. The table sits in its own `overflow-x-auto` box
 * with a `min-w` floor so the columns keep their shape and the BOX scrolls —
 * rather than the document, which would take the header, the summary and the
 * Apply button sideways with it.
 * `src/components/guest-book/confirm-table-geometry.test.ts` measures that in a
 * real browser at 375px, because jsdom performs no layout and every source grep
 * here is satisfied by a class string that lays out wrong.
 */
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import type {
	PendingEntry,
	PendingEntryEdit,
	PendingEntryField,
} from "#/lib/guest-book-pending";
import type {
	ConfirmBlockingItem,
	ConfirmLine,
} from "#/server/guest-book-pending-logic";

/** What each outcome means, in the words a transcriber is thinking in. */
const OUTCOME_LABEL: Record<string, string> = {
	matched: "Existing guest",
	new: "New guest",
	ambiguous: "Needs an answer",
	already_present: "Already recorded",
};

const CELL = "px-3 py-2 align-top";
const HEAD =
	"px-3 py-2 text-left text-xs font-extrabold tracking-[0.06em] text-[var(--sea-ink-soft)] uppercase";

export interface ConfirmEntriesTableProps {
	entries: PendingEntry[];
	lines: ConfirmLine[];
	blocking: ConfirmBlockingItem[];
	busy: boolean;
	onEdit: (edit: PendingEntryEdit) => void;
	/**
	 * The uncommitted text for a field, or `undefined` when there is none.
	 *
	 * `undefined` and not `""`: a field the reader has just CLEARED is a draft
	 * whose value is the empty string, and falling back to the stored value
	 * there would make the box refill itself as they typed.
	 */
	draft: (id: string, field: PendingEntryField) => string | undefined;
	onDraft: (id: string, field: PendingEntryField, value: string) => void;
}

export function ConfirmEntriesTable({
	entries,
	lines,
	blocking,
	busy,
	onEdit,
	draft,
	onDraft,
}: ConfirmEntriesTableProps) {
	const lineFor = new Map(lines.map((l) => [l.entryId, l]));
	const blockingFor = new Map<string, ConfirmBlockingItem[]>();
	for (const item of blocking) {
		if (!item.entryId) continue;
		const list = blockingFor.get(item.entryId) ?? [];
		list.push(item);
		blockingFor.set(item.entryId, list);
	}

	function field(entry: PendingEntry, name: PendingEntryField) {
		const stored = entry[name] ?? "";
		return (
			<Input
				aria-label={`${name} for ${entry.name || "this line"}`}
				className="h-9 min-w-[8rem]"
				disabled={busy || Boolean(entry.dropped)}
				value={draft(entry.id, name) ?? stored}
				onChange={(e) => onDraft(entry.id, name, e.target.value)}
				onBlur={(e) => {
					const value = e.target.value.trim();
					if (value === stored) return;
					// A name has no empty form — the server's validator refuses one —
					// so put the stored value back rather than sending a rejection.
					if (name === "name" && !value) {
						onDraft(entry.id, name, stored);
						return;
					}
					onEdit({ kind: "field", id: entry.id, field: name, value });
				}}
			/>
		);
	}

	return (
		// The scroller. Its own box, so the page does not scroll sideways with it.
		//
		// `relative` is NOT decoration, and it is the whole fix. `overflow-x-auto`
		// clips a normal-flow child, but an ABSOLUTELY positioned descendant is
		// laid out against its nearest POSITIONED ancestor — and without one that
		// is the initial containing block, i.e. the viewport. The `sr-only` label
		// on the last column is exactly that: Tailwind's `sr-only` is
		// `position:absolute`, so it sat at the table's right edge, 861px into a
		// 375px screen, and dragged `documentElement.scrollWidth` out with it.
		// MEASURED at 375px: 861px of document scroll with the class absent, 375
		// with it present — the page scrolled sideways while the box that was
		// supposed to scroll was already clipping correctly, which is why this
		// reads as the table's bug and is not.
		<div className="relative w-full overflow-x-auto rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)]">
			<table className="w-full min-w-[54rem] border-collapse text-sm">
				<thead>
					<tr className="border-b border-[var(--line)] bg-[var(--foam)]">
						<th className={HEAD}>Name</th>
						<th className={HEAD}>Goes by</th>
						<th className={HEAD}>Email</th>
						<th className={HEAD}>Phone</th>
						<th className={HEAD}>What happens</th>
						<th className={HEAD}>
							<span className="sr-only">Include</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{entries.map((entry) => {
						const line = lineFor.get(entry.id);
						const problems = blockingFor.get(entry.id) ?? [];
						const ambiguity = problems.find(
							(p) => p.code === "AMBIGUOUS_GUEST",
						);
						return (
							<tr
								key={entry.id}
								data-entry-id={entry.id}
								className={`border-b border-[var(--line)] last:border-b-0 ${
									entry.dropped ? "opacity-50" : ""
								}`}
							>
								<td className={CELL}>{field(entry, "name")}</td>
								<td className={CELL}>{field(entry, "preferredName")}</td>
								<td className={CELL}>{field(entry, "email")}</td>
								<td className={CELL}>{field(entry, "phone")}</td>
								<td className={`${CELL} min-w-[14rem]`}>
									{entry.dropped ? (
										<span className="text-xs font-semibold text-[var(--sea-ink-soft)]">
											Dropped — this line will not be recorded
										</span>
									) : (
										<>
											<span className="text-xs font-bold text-[var(--sea-ink)]">
												{OUTCOME_LABEL[line?.outcome ?? ""] ?? "—"}
											</span>
											{line?.matchedName ? (
												<span className="block text-xs text-[var(--sea-ink-soft)]">
													On file as {line.matchedName}
												</span>
											) : null}
											{problems.map((p) => (
												<span
													key={`${p.code}-${p.message}`}
													className="mt-1 block text-xs font-semibold text-[var(--ember,#a33)]"
												>
													{p.message}
												</span>
											))}
											{ambiguity ? (
												<select
													aria-label={`Resolve ${entry.name}`}
													className="mt-1.5 h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--surface-strong)] px-2 text-xs"
													disabled={busy}
													value={
														entry.resolve?.kind === "existing"
															? entry.resolve.guestId
															: entry.resolve?.kind === "new"
																? "new"
																: ""
													}
													onChange={(e) => {
														const v = e.target.value;
														onEdit({
															kind: "resolve",
															id: entry.id,
															resolve:
																v === ""
																	? null
																	: v === "new"
																		? { kind: "new" }
																		: { kind: "existing", guestId: v },
														});
													}}
												>
													<option value="">Who is this?</option>
													{/* UNMASKED — see the module header. */}
													{ambiguity.candidates.map((c) => (
														<option key={c.guestId} value={c.guestId}>
															{[c.name, c.email, c.phone]
																.filter(Boolean)
																.join(" · ")}
														</option>
													))}
													<option value="new">Someone new</option>
												</select>
											) : null}
										</>
									)}
								</td>
								<td className={`${CELL} whitespace-nowrap`}>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() =>
											onEdit({
												kind: "dropped",
												id: entry.id,
												dropped: !entry.dropped,
											})
										}
									>
										{entry.dropped ? "Restore" : "Drop"}
									</Button>
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

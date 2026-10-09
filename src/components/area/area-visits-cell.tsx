import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
	type ClubVisits,
	formatVisitDate,
	VISIT_ROUNDS,
	type VisitRound,
} from "#/lib/area-visits";
import { clearClubVisit, recordClubVisit } from "#/server/area-visits";

/**
 * A club's two visit rounds (#1120): "Round 1: Oct 12" and "Round 2: not yet",
 * each with a Record, or an Edit and a Clear, beside it. Used by the area table
 * and by the phone card, so both say the same thing.
 *
 * `readOnly` shows the dates and no controls. The superadmin console's preview
 * passes it: a superadmin with no term cannot call the visit endpoints, and a
 * button that only ever answered "no permission" would be worse than none.
 */
export function AreaVisitsCell({
	areaClubId,
	visits,
	readOnly = false,
}: {
	areaClubId: string;
	visits: ClubVisits | undefined;
	readOnly?: boolean;
}) {
	return (
		<ul className="space-y-1.5 text-sm">
			{VISIT_ROUNDS.map((round) => {
				const date = visits?.[round];
				return (
					<li key={round}>
						{readOnly ? (
							<VisitText round={round} date={date} />
						) : (
							<EditableRound
								areaClubId={areaClubId}
								round={round}
								date={date}
							/>
						)}
					</li>
				);
			})}
		</ul>
	);
}

function VisitText({
	round,
	date,
}: {
	round: VisitRound;
	date: string | undefined;
}) {
	return (
		<span>
			Round {round}:{" "}
			{date ? (
				<span className="font-medium">{formatVisitDate(date)}</span>
			) : (
				<span className="text-muted-foreground">not yet</span>
			)}
		</span>
	);
}

/**
 * One round with its controls. Its own component so `useRouter` is never called
 * on the read-only path, which renders where no router is mounted.
 */
function EditableRound({
	areaClubId,
	round,
	date,
}: {
	areaClubId: string;
	round: VisitRound;
	date: string | undefined;
}) {
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function run(work: () => Promise<unknown>, done: () => void) {
		setBusy(true);
		setError(null);
		try {
			await work();
			done();
			// Reload the page's loader, so the table and the card show the saved date.
			await router.invalidate();
		} catch (err) {
			setError(err instanceof Error ? err.message : "That didn't work.");
		} finally {
			setBusy(false);
		}
	}

	if (editing) {
		return (
			<form
				className="space-y-1.5"
				onSubmit={(event) => {
					event.preventDefault();
					void run(
						() =>
							recordClubVisit({
								data: { areaClubId, round, visitedOn: draft },
							}),
						() => setEditing(false),
					);
				}}
			>
				<div className="flex flex-wrap items-center gap-2">
					<span>Round {round}:</span>
					<Input
						type="date"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						required
						className="h-8 w-auto"
						aria-label={`Round ${round} visit date`}
					/>
				</div>
				<div className="flex gap-2">
					<Button type="submit" size="xs" disabled={busy || draft === ""}>
						Save
					</Button>
					<Button
						type="button"
						size="xs"
						variant="ghost"
						disabled={busy}
						onClick={() => {
							setEditing(false);
							setError(null);
						}}
					>
						Cancel
					</Button>
				</div>
				{error ? <VisitError message={error} /> : null}
			</form>
		);
	}

	return (
		<div className="space-y-1">
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
				<VisitText round={round} date={date} />
				<Button
					type="button"
					size="xs"
					variant="outline"
					disabled={busy}
					aria-label={`${date ? "Edit" : "Record"} round ${round} visit`}
					onClick={() => {
						setDraft(date ?? "");
						setError(null);
						setEditing(true);
					}}
				>
					{date ? "Edit" : "Record"}
				</Button>
				{date ? (
					<Button
						type="button"
						size="xs"
						variant="ghost"
						disabled={busy}
						aria-label={`Clear round ${round} visit`}
						onClick={() =>
							void run(
								() => clearClubVisit({ data: { areaClubId, round } }),
								() => {},
							)
						}
					>
						Clear
					</Button>
				) : null}
			</div>
			{error ? <VisitError message={error} /> : null}
		</div>
	);
}

function VisitError({ message }: { message: string }) {
	return (
		<p role="alert" className="text-xs text-destructive">
			{message}
		</p>
	);
}

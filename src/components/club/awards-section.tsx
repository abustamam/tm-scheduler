import { useMemo } from "react";
import { AssigneePicker } from "#/components/club/table-topics-capture";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import type { useOfflineMinutes } from "#/hooks/use-offline-minutes";
import { useOnlineStatus } from "#/hooks/use-online-status";
import { projectMinutes } from "#/lib/project-minutes";
import {
	clearMinutesAward,
	type MinutesResult,
	setMinutesAward,
} from "#/server/minutes";

type MinutesData = NonNullable<MinutesResult["data"]>;
type AwardCategory = MinutesData["awards"][number]["category"];

const AWARD_LABELS: Record<AwardCategory, string> = {
	best_speaker: "Best Speaker",
	best_evaluator: "Best Evaluator",
	best_table_topics: "Best Table Topics",
};

/**
 * The meeting's awards list (#1583). ONE implementation with two render sites:
 * the Ballots tab renders it editable (winners are decided there), the Minutes
 * tab renders it read-only. Writes go through the route's single offline minutes
 * queue (`offline`), so the two sites and the console's pause agree on one queue.
 *
 * `minutes` is the LOADER payload; this component projects the queue over it
 * itself (the same seam the Minutes card reads), so a caller must not pass an
 * already-projected value.
 */
export function AwardsSection({
	meetingId,
	minutes,
	canEdit,
	offline,
	clubGuests,
	onChangeInBallots,
}: {
	meetingId: string;
	minutes: MinutesData;
	canEdit: boolean;
	offline: ReturnType<typeof useOfflineMinutes>;
	clubGuests: { id: string; name: string; stage?: string }[];
	/** Read-only render only: shows the "Change in Ballots" link when given. */
	onChangeInBallots?: () => void;
}) {
	const { mutate, opMeta, busy, queue, snapshot } = offline;
	const online = useOnlineStatus();
	const displayMinutes = useMemo(
		() => projectMinutes({ online, minutes, snapshot, queue }) ?? minutes,
		[online, minutes, snapshot, queue],
	);
	const roster = displayMinutes.members;

	const guestName = (guestId: string) =>
		clubGuests.find((g) => g.id === guestId)?.name ?? "Guest";
	const memberName = (memberId: string) =>
		roster.find((m) => m.memberId === memberId)?.name ?? "Member";

	const onSet = (
		category: AwardCategory,
		payload: {
			memberId?: string;
			guestId?: string;
			newGuest?: { name: string };
		},
	) =>
		mutate(
			() => setMinutesAward({ data: { meetingId, category, ...payload } }),
			() => {
				const isGuest = !payload.memberId;
				const name = payload.memberId
					? memberName(payload.memberId)
					: payload.guestId
						? guestName(payload.guestId)
						: (payload.newGuest?.name ?? "Guest");
				return {
					type: "setAward",
					...opMeta(),
					category,
					name,
					isGuest,
					memberId: payload.memberId,
					guestId: payload.guestId,
					newGuest: payload.newGuest,
					// Inline new guest: mint its client PK so a drain replay is
					// idempotent (no orphan guest). #176 slice 5.
					newGuestId: payload.newGuest ? crypto.randomUUID() : undefined,
				};
			},
		);
	const onClear = (category: AwardCategory) =>
		mutate(
			() => clearMinutesAward({ data: { meetingId, category } }),
			() => ({ type: "clearAward", ...opMeta(), category }),
		);

	// Scope each award's picker to the people who took that role this meeting
	// (#170): Best Speaker → speaker-slot holders, Best Evaluator → evaluator-slot
	// holders, Best Table Topics → the recorded Table Topics speakers. Falls back
	// to the full roster when nobody was recorded so an award can always be set.
	function eligibleFor(category: AwardCategory): {
		roster: { memberId: string; name: string }[];
		clubGuests: { id: string; name: string; stage?: string }[];
	} {
		const elig = displayMinutes.awardEligible[category];
		const memberIds = new Set(elig.memberIds);
		const scopedRoster = roster.filter((m) => memberIds.has(m.memberId));

		if (category === "best_table_topics") {
			const guestIds = new Set(elig.guestIds);
			const scopedGuests = clubGuests.filter((g) => guestIds.has(g.id));
			// No Table Topics participants recorded → fall back to everyone.
			if (scopedRoster.length === 0 && scopedGuests.length === 0) {
				return { roster, clubGuests };
			}
			return { roster: scopedRoster, clubGuests: scopedGuests };
		}

		// Speaker / Evaluator: filter members, keep all club guests (guest role
		// data may be incomplete). Fall back to the full roster only if empty.
		return {
			roster: scopedRoster.length > 0 ? scopedRoster : roster,
			clubGuests,
		};
	}

	return (
		<section className="space-y-3">
			<h3 className="font-semibold text-sm">Awards</h3>
			<ul className="space-y-2">
				{displayMinutes.awards.map((a) => (
					<li
						key={a.category}
						className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
					>
						<span className="text-sm">
							<span className="font-semibold">{AWARD_LABELS[a.category]}</span>
							{": "}
							{a.name ? (
								<>
									{a.name}
									{a.isGuest ? (
										<Badge variant="outline" className="ml-2">
											Guest
										</Badge>
									) : null}
								</>
							) : (
								<span className="text-muted-foreground">Not set</span>
							)}
						</span>
						{canEdit ? (
							<div className="flex items-center gap-1">
								<AssigneePicker
									label={a.name ? "Change" : "Set"}
									roster={eligibleFor(a.category).roster}
									clubGuests={eligibleFor(a.category).clubGuests}
									busy={busy}
									onPick={(payload) => onSet(a.category, payload)}
								/>
								{a.name ? (
									<Button
										type="button"
										size="sm"
										variant="ghost"
										disabled={busy}
										onClick={() => onClear(a.category)}
									>
										Clear
									</Button>
								) : null}
							</div>
						) : null}
					</li>
				))}
			</ul>
			{!canEdit && onChangeInBallots ? (
				<Button
					type="button"
					variant="link"
					size="sm"
					className="h-auto p-0"
					onClick={onChangeInBallots}
				>
					Change in Ballots
				</Button>
			) : null}
		</section>
	);
}

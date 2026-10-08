import { Link } from "@tanstack/react-router";
import { Circle, CircleCheck, Presentation } from "lucide-react";
import type { MeetingReadiness, ReadinessGap } from "#/lib/meeting-readiness";

/** How many gaps a row names before it says "+N more". The data never truncates. */
const MAX_GAPS_SHOWN = 3;

/** "Speaker 2 (Pat)", or "Ah-Counter (open)" when nobody holds the slot. */
const gapText = (gap: ReadinessGap): string =>
	`${gap.slotLabel} (${gap.holderName ?? "open"})`;

/**
 * "Is this meeting ready?" in one card (#963), for the officers and that
 * meeting's Toastmaster of the Day.
 *
 * READ-ONLY, on purpose. It names who is behind and sends nothing, writes
 * nothing and has no button: asking a person is the officer's own move, from the
 * agenda directly below, which keeps its nudge drafts unchanged. That is
 * `.out-of-scope/automatic-open-role-nudges.md` and ADR-0028 (humans send every
 * message) applied to a panel that could otherwise grow a "remind them" button.
 *
 * The deck gets a link and no line of its own: the projected deck is built from
 * the same meeting data (a blank theme or Word of the Day drops its slide), so
 * "deck ready" IS the theme, Word of the Day and speech-detail rows above.
 *
 * The component is handed its answer and decides nothing about WHO sees it; the
 * route gates it with `canSeeMeetingReadiness` / `showsMeetingReadiness`.
 */
export function MeetingReadinessPanel({
	readiness,
	clubId,
	meetingId,
}: {
	readiness: MeetingReadiness;
	/** The club slug the route links with. */
	clubId: string;
	/** The meeting key the route links with (`urlKey`), not necessarily the uuid. */
	meetingId: string;
}) {
	// Built the way `MeetingToolbar`'s Present link is, so the two cannot open
	// different pages. A new tab: the meeting page stays where the officer left it.
	const deckLink = (
		<Link
			to="/club/$clubId/meeting/$meetingId/present"
			params={{ clubId, meetingId }}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1.5 text-sm"
		>
			<Presentation className="size-4" aria-hidden />
			Preview the deck
		</Link>
	);

	if (readiness.ready) {
		return (
			<section
				aria-label="Meeting readiness"
				data-testid="meeting-readiness-panel"
				className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border bg-card px-4 py-3"
			>
				<p className="flex min-w-0 items-center gap-2 text-sm font-medium">
					<CircleCheck className="size-4 shrink-0 text-success" aria-hidden />
					Everything's set for this meeting
				</p>
				{deckLink}
			</section>
		);
	}

	return (
		<section
			aria-labelledby="meeting-readiness-title"
			data-testid="meeting-readiness-panel"
			className="space-y-3 rounded-lg border bg-card px-4 py-3"
		>
			<h2 id="meeting-readiness-title" className="text-sm font-semibold">
				Before the meeting
			</h2>
			<ul className="space-y-2">
				{readiness.items.map((item) => {
					const shown = item.gaps.slice(0, MAX_GAPS_SHOWN);
					const more = item.gaps.length - shown.length;
					return (
						<li
							key={item.id}
							data-testid={`readiness-item-${item.id}`}
							data-done={item.done}
							className="flex items-start gap-2 text-sm"
						>
							{item.done ? (
								<CircleCheck
									className="mt-0.5 size-4 shrink-0 text-success"
									aria-hidden
								/>
							) : (
								<Circle
									className="mt-0.5 size-4 shrink-0 text-muted-foreground"
									aria-hidden
								/>
							)}
							<div className="min-w-0 flex-1 break-words">
								<span className="font-medium">{item.label}</span>{" "}
								<span className="text-muted-foreground tabular-nums">
									{item.doneCount}/{item.total}
								</span>
								<span className="sr-only">
									{item.done ? ", done" : ", not done"}
								</span>
								{shown.length > 0 ? (
									<p className="text-muted-foreground text-xs">
										{shown.map(gapText).join(", ")}
										{more > 0 ? `, +${more} more` : ""}
									</p>
								) : null}
							</div>
						</li>
					);
				})}
			</ul>
			{deckLink}
		</section>
	);
}

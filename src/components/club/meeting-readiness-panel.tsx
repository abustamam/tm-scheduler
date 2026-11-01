import { Link } from "@tanstack/react-router";
import { Circle, CircleCheck, Presentation, Share2 } from "lucide-react";
import { toast } from "sonner";
import { droppedAt } from "#/components/club/cover-chip";
import { Button } from "#/components/ui/button";
import { buildCoverCall, coverLink } from "#/lib/cover";
import type { MeetingReadiness, ReadinessGap } from "#/lib/meeting-readiness";

/** How many gaps a row names before it says "+N more". The data never truncates. */
const MAX_GAPS_SHOWN = 3;

/** "a Timer" / "an Evaluator": a leading vowel takes "an". */
const withArticle = (label: string): string =>
	`${/^[aeiou]/i.test(label) ? "an" : "a"} ${label}`;

/** "Speaker 2 (Pat)", or "Ah-Counter (open)" when nobody holds the slot. */
const gapText = (gap: ReadinessGap): string =>
	`${gap.slotLabel} (${gap.holderName ?? "open"})`;

/** "Open: Sam dropped it Tue 9:14pm" / "Sam is finding cover". */
function coverNote(
	cover: NonNullable<ReadinessGap["cover"]>,
	timezone: string,
): string {
	return cover.status === "dropped"
		? `Open: ${cover.releasedName} dropped it ${droppedAt(new Date(cover.releasedAt), timezone)}`
		: `${cover.releasedName} is finding cover`;
}

/**
 * The officer's own group call (#1441): the share sheet on a phone (a browser
 * with `navigator.share` AND a coarse pointer; desktop Safari/Chrome also have
 * `share`, but there the button says "Copy"), the clipboard otherwise. A person
 * sends it; nothing here does.
 */
async function shareCoverCall(text: string): Promise<void> {
	try {
		const onPhone =
			typeof navigator.share === "function" &&
			typeof window.matchMedia === "function" &&
			window.matchMedia("(pointer: coarse)").matches;
		if (onPhone) {
			await navigator.share({ text });
			return;
		}
		await navigator.clipboard.writeText(text);
		toast.success("Copied. Paste it to the group.");
	} catch (err) {
		// Closing the share sheet is a choice, not a failure.
		if (err instanceof DOMException && err.name === "AbortError") return;
		toast.error("Couldn't copy. Your browser blocked clipboard access");
	}
}

/**
 * "Is this meeting ready?" in one card (#963), for club admins and that
 * meeting's Toastmaster of the Day.
 *
 * READ-ONLY, on purpose. It names who is behind and sends nothing and writes
 * nothing: asking a person is the reader's own move, from the agenda directly
 * below, which keeps its nudge drafts unchanged. The one button is a role a
 * member handed back (#1441): it DRAFTS the group call for the officer to send.
 * That is `.out-of-scope/automatic-open-role-nudges.md` and ADR-0028 (humans
 * send every message) applied to a panel that could otherwise grow a "remind
 * them" button.
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
	timezone,
}: {
	readiness: MeetingReadiness;
	/** The club slug the route links with. */
	clubId: string;
	/** The meeting key the route links with (`urlKey`), not necessarily the uuid. */
	meetingId: string;
	/** The club's zone, for the "dropped it Tue 9:14pm" note. */
	timezone: string;
}) {
	// Built the way `MeetingToolbar`'s Present link is: the same route, the same
	// params (the route's club slug and URL meeting key) and a new tab, so the
	// meeting page stays where the reader left it. Nothing ties the two call
	// sites together, so a change to one is a change to look for in the other.
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
				<p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
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
								<span className="font-semibold">{item.label}</span>{" "}
								<span className="text-muted-foreground tabular-nums">
									{item.doneCount}/{item.total}
								</span>
								<span className="sr-only">
									{item.done ? ", done" : ", not done"}
								</span>
								{shown
									.filter(
										(
											gap,
										): gap is ReadinessGap & {
											cover: NonNullable<ReadinessGap["cover"]>;
										} => Boolean(gap.cover),
									)
									.map((gap) => {
										const cover = gap.cover;
										return (
											<div
												key={gap.slotId}
												data-testid={`readiness-cover-${gap.slotId}`}
												className="mt-1.5 space-y-1.5"
											>
												<p className="text-xs">
													<span className="font-semibold">{gap.slotLabel}</span>{" "}
													<span className="text-warning-foreground">
														{coverNote(cover, timezone)}
													</span>
												</p>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														shareCoverCall(
															buildCoverCall({
																role: gap.slotLabel,
																when: cover.weekday,
																link: coverLink(
																	window.location.origin,
																	clubId,
																	meetingId,
																	gap.slotId,
																),
															}),
														)
													}
												>
													<Share2 className="size-4" aria-hidden />
													Copy "we need {withArticle(gap.slotLabel)}"
												</Button>
											</div>
										);
									})}
								{shown.some((gap) => !gap.cover) || more > 0 ? (
									<p className="text-muted-foreground text-xs">
										{shown
											.filter((gap) => !gap.cover)
											.map(gapText)
											.join(", ")}
										{more > 0
											? `${shown.some((gap) => !gap.cover) ? ", " : ""}+${more} more`
											: ""}
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

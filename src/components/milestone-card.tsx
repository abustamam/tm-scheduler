import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	dueMilestones,
	MILESTONE_COPY,
	MILESTONES_STORAGE_KEY,
	type Milestone,
	type MilestoneCounts,
	milestoneKey,
} from "#/lib/milestones";
import { addToStoredSet, readStoredSet } from "#/lib/whats-new";

export const MILESTONE_DISMISS_LABEL = "Nice";

// Eight dots, 45 degrees apart; each one's angle is a CSS variable so the one
// `celebrate-dot` keyframe moves all of them outward along their own ray.
const DOTS = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
	angle: i * 45,
	tone: (["palm", "warning", "lagoon"] as const)[i % 3],
}));

/**
 * The second authored moment (DESIGN.md, #1425): one celebration card at the
 * top of the dashboard. Shows the first due milestone, in order, and marks it
 * seen the moment it shows, so it appears once per device. A second due
 * milestone waits for the NEXT dashboard load.
 *
 * Browser storage is read after mount (the server has no storage, and reading
 * it during render would split the SSR and hydration passes). When storage is
 * unavailable nothing shows: a card that could not be remembered would repeat.
 */
export function MilestoneCard({
	memberId,
	counts,
}: {
	memberId: string;
	counts: MilestoneCounts;
}) {
	const [shown, setShown] = useState<Milestone | null>(null);
	const [dismissed, setDismissed] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: decided once per mount; a count change mid-visit must not swap the card.
	useEffect(() => {
		const seen = readStoredSet(MILESTONES_STORAGE_KEY);
		if (seen === null) return;
		const first = dueMilestones(memberId, counts, seen)[0];
		if (!first) return;
		addToStoredSet(MILESTONES_STORAGE_KEY, milestoneKey(memberId, first));
		setShown(first);
	}, []);

	if (!shown || dismissed) return null;
	const copy = MILESTONE_COPY[shown];
	return (
		<section
			aria-labelledby="milestone-heading"
			className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-border bg-surface-raised px-5 py-4 shadow-[0_10px_24px_rgba(23,58,64,.05)]"
		>
			<div className="relative grid size-12 shrink-0 place-items-center">
				<span className="milestone-check grid size-10 place-items-center rounded-full bg-success text-white">
					<Check className="size-5" aria-hidden />
				</span>
				{DOTS.map((d) => (
					<span
						key={d.angle}
						aria-hidden
						className="milestone-dot"
						data-tone={d.tone}
						style={{ "--angle": `${d.angle}deg` } as React.CSSProperties}
					/>
				))}
			</div>
			<div className="min-w-48 flex-1">
				<h2
					id="milestone-heading"
					className="display-title m-0 text-lg font-semibold"
				>
					{copy.heading}
				</h2>
				<p className="m-0 mt-0.5 text-sm text-muted-foreground">{copy.body}</p>
			</div>
			<Button size="touch" variant="outline" onClick={() => setDismissed(true)}>
				{MILESTONE_DISMISS_LABEL}
			</Button>
		</section>
	);
}

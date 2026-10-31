import { Button } from "#/components/ui/button";
import type { MeetingCoverRequest } from "#/server/cover-logic";

interface LandingSlot {
	id: string;
	assigneeId: string | null;
	assigneeGuestId: string | null;
	assigneeName?: string | null;
}

export type CoverLanding =
	| { kind: "open"; slotId: string; request: MeetingCoverRequest }
	| { kind: "filled"; holderName: string | null };

/**
 * What `?cover=<slotId>` lands on (#1440). Never throws on a stale link: an
 * unknown id, a slot of another meeting (not in `slots`), a slot that is open
 * with no request, and a meeting that is over all read as "no card". A slot
 * that has since been filled reads as the thanks line.
 */
export function resolveCoverLanding(args: {
	cover: unknown;
	slots: LandingSlot[];
	coverRequests: MeetingCoverRequest[];
	meetingOver: boolean;
}): CoverLanding | null {
	if (typeof args.cover !== "string" || args.meetingOver) return null;
	const slot = args.slots.find((s) => s.id === args.cover);
	if (!slot) return null;
	if (slot.assigneeId !== null || slot.assigneeGuestId !== null) {
		return { kind: "filled", holderName: slot.assigneeName ?? null };
	}
	const request = args.coverRequests.find(
		(r) => r.slotId === slot.id && r.coveredAt === null,
	);
	return request ? { kind: "open", slotId: slot.id, request } : null;
}

/**
 * The card above the lineup for someone who followed a cover link: who asked,
 * which role, when, what it is, and two buttons. "I'll take it" is the page's
 * existing claim (which asks a signed-out visitor for their name first).
 */
export function CoverLandingCard({
	landing,
	roleLabel,
	whenLine,
	description,
	busy,
	onTake,
	onDecline,
}: {
	landing: CoverLanding;
	roleLabel: string;
	/** "<Weekday> · Meeting <n> · <time>" */
	whenLine: string;
	description: string | null;
	busy?: boolean;
	onTake: () => void;
	onDecline: () => void;
}) {
	if (landing.kind === "filled") {
		return (
			<p
				data-cover-landing="filled"
				className="rounded-xl border bg-card px-4 py-3 text-sm font-semibold"
			>
				Thanks!{" "}
				{landing.holderName
					? `${landing.holderName} already`
					: "Someone already"}{" "}
				took it.
			</p>
		);
	}
	return (
		<section
			data-cover-landing="open"
			aria-label="Cover request"
			className="flex flex-col gap-2 rounded-xl border border-warning bg-warning/10 p-4"
		>
			<p className="text-sm font-semibold text-warning-foreground">
				{landing.request.releasedName} asked if you can cover
			</p>
			<h2 className="font-display text-2xl font-semibold tracking-tight">
				{roleLabel}
			</h2>
			<p className="text-sm text-muted-foreground">{whenLine}</p>
			{description ? <p className="text-sm">{description}</p> : null}
			<div className="mt-1 flex flex-wrap gap-2">
				<Button type="button" disabled={busy} onClick={onTake}>
					I'll take it
				</Button>
				<Button
					type="button"
					variant="outline"
					disabled={busy}
					onClick={onDecline}
				>
					Can't, sorry
				</Button>
			</div>
		</section>
	);
}

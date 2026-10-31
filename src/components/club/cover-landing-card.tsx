import { Button } from "#/components/ui/button";
import { slotLabel } from "#/lib/agenda";
import { APP_LOCALE, formatMeetingTime } from "#/lib/format";
import { blankToNull, roleGuide } from "#/lib/role-guide";
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

/** The role's one-liner: its description, else the first paragraph of its
 *  Before guide, else of its During guide. Null when the club wrote none. */
export function coverRoleOneLiner(
	def: {
		name: string;
		key?: string | null;
		description: string | null;
		beforeNotes?: string | null;
		duringNotes?: string | null;
	} | null,
): string | null {
	if (!def) return null;
	const g = roleGuide(def);
	const firstParagraph = (t: string | null) =>
		blankToNull(t?.split(/\n\s*\n/)[0]);
	return g.description ?? firstParagraph(g.before) ?? firstParagraph(g.during);
}

/** "<Weekday> · Meeting <n> · <time>" */
export function coverWhenLine(args: {
	scheduledAt: Date;
	timezone: string;
	meetingNumber: number | null | undefined;
}): string {
	return [
		new Intl.DateTimeFormat(APP_LOCALE, {
			weekday: "long",
			timeZone: args.timezone,
		}).format(args.scheduledAt),
		args.meetingNumber != null ? `Meeting ${args.meetingNumber}` : null,
		formatMeetingTime(args.scheduledAt, args.timezone),
	]
		.filter(Boolean)
		.join(" · ");
}

/** Everything the route hands the card, computed from the page's own data. */
export function coverLandingView(args: {
	cover: unknown;
	dismissed: boolean;
	slots: (LandingSlot & {
		roleName: string;
		slotIndex: number;
		slotsUnordered?: boolean;
	})[];
	coverRequests: MeetingCoverRequest[];
	meetingOver: boolean;
	roleCounts: Record<string, number>;
	roleDefs:
		| {
				name: string;
				key?: string | null;
				description: string | null;
				beforeNotes?: string | null;
				duringNotes?: string | null;
		  }[]
		| undefined;
	scheduledAt: Date;
	timezone: string;
	meetingNumber: number | null | undefined;
}) {
	const landing = args.dismissed ? null : resolveCoverLanding(args);
	const slot =
		landing?.kind === "open"
			? args.slots.find((s) => s.id === landing.slotId)
			: undefined;
	return {
		landing,
		slot,
		roleLabel: slot ? slotLabel(slot, args.roleCounts) : "",
		description: slot
			? coverRoleOneLiner(
					args.roleDefs?.find((r) => r.name === slot.roleName) ?? null,
				)
			: null,
		whenLine: coverWhenLine(args),
	};
}

/**
 * "I'll take it": resolve who is taking it, claim, say so, and refresh the
 * page so the card and the lineup show the slot filled. `claim` resolves false
 * when no identity was given (the name picker was dismissed): nothing was
 * written, so no toast. A refresh that fails after the write landed is not an
 * error to show: the claim worked.
 */
export async function takeCoveredSlot(args: {
	claim: () => Promise<boolean>;
	refresh: () => Promise<unknown>;
	onTaken: () => void;
	onError: (err: unknown) => void;
	setBusy: (busy: boolean) => void;
}): Promise<void> {
	args.setBusy(true);
	try {
		if (!(await args.claim())) return;
		args.onTaken();
		try {
			await args.refresh();
		} catch {
			// the claim landed; the next navigation shows it
		}
	} catch (err) {
		args.onError(err);
	} finally {
		args.setBusy(false);
	}
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

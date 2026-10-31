import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { guestVisitLabel } from "#/lib/attendance-panel";

/** A guest who RSVP'd (#1444): what the officer needs to greet them. */
export interface ExpectedGuest {
	guestId: string;
	name: string;
	/** Past visits plus one. */
	visitNumber: number;
}

/**
 * The guests who said they are coming (#1444, eng review D7).
 *
 * Two uses, one list. Before the meeting (`onHere` omitted) it is the
 * officer's "who to look out for": a name and "first visit" / "3rd visit".
 * On the roll (`onHere` given) each row also has Here, which records the guest
 * present through the guest-add write the roll already uses (so its offline
 * queue and its once-per-guest idempotence). An expected guest is not present,
 * and not a visit, until that tap: this list never writes by itself.
 *
 * A guest already on the roll is not listed again; the route filters on the
 * rows it already shows, so this component holds no second copy of "present".
 */
export function AttendanceExpectedGuests({
	guests,
	locked,
	onHere,
}: {
	guests: ExpectedGuest[];
	/** Disables Here, with the same meaning as the guests group's `locked`. */
	locked?: boolean;
	onHere?: (guestId: string) => void | Promise<void>;
}) {
	if (guests.length === 0) return null;
	return (
		<section className="space-y-2" aria-label="Expected guests">
			<h3 className="font-semibold text-sm">
				{onHere ? "Expected (RSVP'd)" : "Guests coming"}
			</h3>
			{/* biome-ignore lint/a11y/noRedundantRoles: preflight's `list-style: none` makes WebKit drop the implicit list role */}
			{/* biome-ignore lint/a11y/useSemanticElements: this already IS a <ul>; the rule misfires when the explicit role matches the element */}
			<ul role="list" className="space-y-1">
				{guests.map((g) => (
					<li
						key={g.guestId}
						className="flex min-h-11 items-center justify-between gap-2"
					>
						<span className="min-w-0 flex-1 truncate text-sm">{g.name}</span>
						<Badge variant="secondary" className="shrink-0">
							{guestVisitLabel(g.visitNumber)}
						</Badge>
						{onHere ? (
							<Button
								size="sm"
								variant="outline"
								className="min-h-11 shrink-0 sm:min-h-9"
								disabled={locked}
								aria-label={`Mark ${g.name} here`}
								onClick={() => void onHere(g.guestId)}
							>
								Here
							</Button>
						) : null}
					</li>
				))}
			</ul>
		</section>
	);
}

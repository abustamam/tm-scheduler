import { CalendarClock, MapPin } from "lucide-react";
import type { PublicClubProfile } from "#/server/clubs-logic";

/**
 * "About this club" — the club's own basics for a guest who was handed the
 * link: when it meets, which district, and its mission (#318).
 *
 * These fields already existed on `clubs` and already appear on the printed
 * agenda, but no public surface rendered them, so a guest arriving at the club
 * page could not see when the club meets.
 *
 * Renders NOTHING when every field is unset — an empty card with a heading and
 * no content is worse than no card. Matches how the printed agenda treats the
 * same fields ("falls back gracefully — no empty labels").
 *
 * Type-only import of `PublicClubProfile` from a server module: `import type`
 * is erased at compile time, so this does not drag `#/db` into the client
 * bundle. See the server-module rule in CLAUDE.md.
 */
export function AboutClub({
	clubName,
	profile,
}: {
	clubName: string;
	profile: PublicClubProfile | null;
}) {
	// Guard on whitespace, not just null: `emptyToNull` normalizes on write, but
	// rows seeded or imported before that normalization can still hold blanks.
	const meetingSchedule = profile?.meetingSchedule?.trim() || null;
	const district = profile?.district?.trim() || null;
	const mission = profile?.mission?.trim() || null;

	if (!meetingSchedule && !district && !mission) return null;

	return (
		<section className="rounded-xl border border-[var(--line)] bg-card p-4">
			<h2 className="text-sm font-semibold text-foreground">
				About {clubName}
			</h2>
			{meetingSchedule || district ? (
				<dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
					{meetingSchedule ? (
						<div className="flex items-center gap-1.5">
							<CalendarClock
								className="size-3.5 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							<dt className="sr-only">Meets</dt>
							<dd className="text-foreground">{meetingSchedule}</dd>
						</div>
					) : null}
					{district ? (
						<div className="flex items-center gap-1.5">
							<MapPin
								className="size-3.5 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							<dt className="sr-only">District</dt>
							<dd className="text-foreground">{district}</dd>
						</div>
					) : null}
				</dl>
			) : null}
			{mission ? (
				// `mission` is free text and may be multi-line (see the schema comment
				// on `clubs.mission`), so preserve the author's line breaks.
				<p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">
					{mission}
				</p>
			) : null}
		</section>
	);
}

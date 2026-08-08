import { CalendarDays, Landmark } from "lucide-react";
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
				// A `dl > div` may contain only dt/dd (plus script-supporting
				// elements), so the icons live INSIDE the `dd` rather than beside
				// it — same rendering, valid content model.
				<dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
					{meetingSchedule ? (
						<div className="min-w-0">
							<dt className="sr-only">Meets</dt>
							<dd className="flex items-center gap-1.5 break-words text-foreground">
								<CalendarDays
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								{meetingSchedule}
							</dd>
						</div>
					) : null}
					{district ? (
						<div className="min-w-0">
							<dt className="sr-only">District</dt>
							<dd className="flex items-center gap-1.5 break-words text-foreground">
								{/* Not MapPin — a district is an organizational grouping,
								    and MapPin already marks the physical `meeting.location`
								    on the agenda a guest reads right after this. */}
								<Landmark
									className="size-3.5 shrink-0 text-muted-foreground"
									aria-hidden
								/>
								{district}
							</dd>
						</div>
					) : null}
				</dl>
			) : null}
			{mission ? (
				// `mission` is free text and may be multi-line (see the schema comment
				// on `clubs.mission`), so preserve the author's line breaks.
				// `break-words` because a length cap bounds code points, not line-break
				// opportunities — one pasted URL would otherwise scroll the page.
				<p className="mt-2 break-words whitespace-pre-line text-sm text-muted-foreground">
					{mission}
				</p>
			) : null}
		</section>
	);
}

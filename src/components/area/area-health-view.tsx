import { AreaClubCard } from "#/components/area/area-club-card";
import { AreaHealthTable } from "#/components/area/area-health-table";
import {
	formatAsOf,
	RECENT_WINDOW_NOTE,
} from "#/components/area/area-health-values";
import type { AreaHealth } from "#/lib/area-health";

/**
 * An area's health as its Area Director sees it (#1119): when the numbers were
 * read, then one row per club on a desktop and one card per club on a phone.
 * The Area Director's page and the superadmin console's preview both render
 * this, so the preview is the page and not a look-alike.
 */
export function AreaHealthView({ health }: { health: AreaHealth }) {
	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				As of {formatAsOf(health.asOf)}. {RECENT_WINDOW_NOTE}
			</p>
			{health.clubs.length === 0 ? (
				<p className="rounded-xl border border-[var(--line)] bg-[var(--surface-strong)] p-4 text-sm text-muted-foreground">
					There are no clubs in this area yet.
				</p>
			) : (
				<>
					<AreaHealthTable clubs={health.clubs} />
					<div className="space-y-3 md:hidden">
						{health.clubs.map((club) => (
							<AreaClubCard key={club.areaClubId} club={club} />
						))}
					</div>
				</>
			)}
		</div>
	);
}

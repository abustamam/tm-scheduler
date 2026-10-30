import { PageContainer } from "#/components/page-container";
import { Skeleton } from "#/components/ui/skeleton";
import { CELL_BASE } from "./grid-cell";

/** The public club page's wrapper (`club.$clubId.index.tsx`), shared so its
 *  skeleton sits where the real header will. */
export const CLUB_HOME_WRAPPER_CLASS =
	"mx-auto w-full max-w-public space-y-6 p-4 pb-8 md:p-6";
/** `/schedule`'s PageContainer className. */
export const SCHEDULE_PAGE_CLASS = "space-y-4";

const ROWS = 8;
// 2 meeting columns at 375px, 4 from md up: the last two hide below md.
const COLUMNS = [false, false, true, true];

/** Placeholder for the season grid while its loader is pending. Cell heights
 *  come from `CELL_BASE` (44px below md, 32px at md+), and the label column is
 *  the grid's own `w-36` (9rem). */
export function SeasonGridSkeleton() {
	return (
		<div data-testid="season-grid-skeleton" aria-hidden className="space-y-2">
			{Array.from({ length: ROWS }, (_, row) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
				<div key={row} className="flex items-center gap-2">
					<Skeleton className="h-4 w-36 shrink-0" />
					{COLUMNS.map((desktopOnly, col) => (
						<div
							// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder columns
							key={col}
							className={desktopOnly ? "hidden flex-1 md:block" : "flex-1"}
						>
							<Skeleton
								data-testid="season-grid-skeleton-cell"
								className={CELL_BASE}
							/>
						</div>
					))}
				</div>
			))}
		</div>
	);
}

export function ScheduleSkeleton() {
	return (
		<PageContainer className={SCHEDULE_PAGE_CLASS}>
			<Skeleton className="h-9 w-48" />
			<SeasonGridSkeleton />
		</PageContainer>
	);
}

export function ClubHomeSkeleton() {
	return (
		<div className={CLUB_HOME_WRAPPER_CLASS}>
			<Skeleton className="h-9 w-64" />
			<SeasonGridSkeleton />
		</div>
	);
}

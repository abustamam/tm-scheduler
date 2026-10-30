import { PageContainer } from "#/components/page-container";
import {
	CLUB_HOME_WRAPPER_CLASS,
	SCHEDULE_PAGE_CLASS,
	SEASON_DATE_HEAD_CLASS,
	SEASON_LABEL_HEAD_CLASS,
	SEASON_LABEL_ROW_CLASS,
	SEASON_SCROLLER_CLASS,
	SEASON_TABLE_CLASS,
	SEASON_TABLE_FRAME_CLASS,
	SEASON_VIEW_TOGGLE_CLASS,
} from "#/components/route-layout";
import { Skeleton } from "#/components/ui/skeleton";
import { CELL_BASE } from "./grid-cell";

const ROWS = 8;
/** The real grid scrolls sideways; a few date columns, as on a 375px phone. */
const COLUMNS = 6;

/** Placeholder for the season grid while its loader is pending. It mirrors the
 *  real grid's structure: the view-toggle row, then a bordered, horizontally
 *  scrolling `border-spacing-1` table with a date header row, a `w-36` label
 *  column and `CELL_BASE` cells (so the height is the grid's own). */
export function SeasonGridSkeleton() {
	return (
		<div data-testid="season-grid-skeleton" aria-hidden className="space-y-4">
			<div data-testid="season-grid-skeleton-toggle">
				<div className={SEASON_VIEW_TOGGLE_CLASS}>
					<Skeleton className="h-7 w-24 rounded-none" />
					<Skeleton className="h-7 w-24 rounded-none" />
				</div>
			</div>
			<div className={SEASON_TABLE_FRAME_CLASS}>
				<div className={SEASON_SCROLLER_CLASS}>
					<table className={SEASON_TABLE_CLASS}>
						<thead>
							<tr data-testid="season-grid-skeleton-head">
								<th className={SEASON_LABEL_HEAD_CLASS}>
									<Skeleton className="h-4 w-16" />
								</th>
								{Array.from({ length: COLUMNS }, (_, col) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder columns
									<th key={col} className={SEASON_DATE_HEAD_CLASS}>
										<Skeleton className="mx-auto h-4 w-10" />
										<Skeleton className="mx-auto mt-1 h-3 w-8" />
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{Array.from({ length: ROWS }, (_, row) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
								<tr key={row} data-testid="season-grid-skeleton-row">
									<th className={SEASON_LABEL_ROW_CLASS}>
										<Skeleton className="h-4 w-full" />
									</th>
									{Array.from({ length: COLUMNS }, (_, col) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder columns
										<td key={col}>
											<Skeleton
												data-testid="season-grid-skeleton-cell"
												className={CELL_BASE}
											/>
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
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

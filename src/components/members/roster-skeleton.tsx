import { PageContainer } from "#/components/page-container";
import {
	ROSTER_FILTER_ROW_CLASS,
	ROSTER_HEADER_ROW_CLASS,
	ROSTER_ROW_CLASS,
	ROSTER_STATS_GRID_CLASS,
	ROSTER_TABLE_CLASS,
	ROSTER_TABLE_GRID,
} from "#/components/route-layout";
import { Skeleton } from "#/components/ui/skeleton";

const ROWS = 8;

/** Placeholder for `/roster`: heading and subtitle, the stat-card grid, the
 *  filter-chip row, then ONE bordered table with a column-header row and rows
 *  on the real page's grid template. */
export function RosterSkeleton() {
	return (
		<PageContainer>
			<div className="mb-5">
				<Skeleton className="h-9 w-48" />
				<Skeleton className="mt-2 h-4 w-72 max-w-full" />
			</div>
			<div
				className={ROSTER_STATS_GRID_CLASS}
				data-testid="roster-skeleton-stats"
			>
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-24 rounded-xl" />
				))}
			</div>
			<div
				className={ROSTER_FILTER_ROW_CLASS}
				data-testid="roster-skeleton-filters"
			>
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-11 w-28 rounded-full" />
				))}
			</div>
			<div
				data-testid="roster-skeleton"
				aria-hidden
				className={ROSTER_TABLE_CLASS}
			>
				<div
					data-testid="roster-skeleton-head"
					className={`${ROSTER_HEADER_ROW_CLASS} ${ROSTER_TABLE_GRID}`}
				>
					<Skeleton className="h-3 w-16" />
					<Skeleton className="hidden h-3 w-16 sm:block" />
					<Skeleton className="hidden h-3 w-16 sm:block" />
					<Skeleton className="hidden h-3 w-12 xl:block" />
					<div />
				</div>
				{Array.from({ length: ROWS }, (_, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
						key={i}
						data-testid="roster-skeleton-row"
						className={`${ROSTER_ROW_CLASS} ${ROSTER_TABLE_GRID}`}
					>
						<div className="flex min-w-0 items-center gap-3">
							<Skeleton className="size-[38px] shrink-0 rounded-full" />
							<Skeleton className="h-4 w-40 max-w-[60%]" />
						</div>
						<Skeleton className="hidden h-4 w-10 sm:block" />
						<Skeleton className="hidden h-4 w-24 sm:block" />
						<Skeleton className="hidden h-4 w-20 xl:block" />
						<Skeleton className="size-4 justify-self-end" />
					</div>
				))}
			</div>
		</PageContainer>
	);
}

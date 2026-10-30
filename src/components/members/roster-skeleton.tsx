import { PageContainer } from "#/components/page-container";
import { Skeleton } from "#/components/ui/skeleton";

/** Eight one-line rows (avatar, name, chip) inside the roster's own
 *  PageContainer, so the heading and first row sit where the real ones will. */
export function RosterSkeleton() {
	return (
		<PageContainer>
			<Skeleton className="mb-5 h-9 w-48" />
			<ul data-testid="roster-skeleton" aria-hidden className="space-y-2">
				{Array.from({ length: 8 }, (_, i) => (
					<li
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
						key={i}
						data-testid="roster-skeleton-row"
						className="flex items-center gap-3 rounded-xl border bg-card p-3"
					>
						<Skeleton className="size-9 shrink-0 rounded-full" />
						<Skeleton className="h-4 w-40 max-w-[50%]" />
						<Skeleton className="ml-auto h-5 w-16 rounded-full" />
					</li>
				))}
			</ul>
		</PageContainer>
	);
}

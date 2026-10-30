/**
 * Layout classes a route's real page and its loading skeleton must share
 * (#1424), so the skeleton imports them instead of retyping. Lives in neither
 * the route nor the skeleton: a route imports its skeleton, so the reverse
 * import would be a cycle.
 *
 * The `SEASON_*` and `ROSTER_*` strings that mirror a class in an uncited file
 * (`season-grid.tsx`, `roster.tsx` inline JSX) are pinned to that source by
 * `route-skeletons.test.tsx`, which reads the file and asserts each appears.
 */

/** `/schedule`'s PageContainer className. */
export const SCHEDULE_PAGE_CLASS = "space-y-4";
/** The public club page's wrapper (`club.$clubId.index.tsx`). */
export const CLUB_HOME_WRAPPER_CLASS =
	"mx-auto w-full max-w-public space-y-6 p-4 pb-8 md:p-6";

// season-grid.tsx
export const SEASON_TABLE_CLASS = "border-separate border-spacing-1";
export const SEASON_LABEL_HEAD_CLASS =
	"sticky top-0 left-0 z-20 w-36 max-w-36 bg-card px-3 py-2 text-left text-xs font-semibold";
export const SEASON_DATE_HEAD_CLASS =
	"sticky top-0 min-w-[3.5rem] bg-card px-2 py-2 text-center text-xs font-semibold";
export const SEASON_LABEL_ROW_CLASS =
	"sticky left-0 z-10 w-36 max-w-36 px-3 py-1 text-left text-xs font-semibold";
export const SEASON_TABLE_FRAME_CLASS = "rounded-xl border";
export const SEASON_SCROLLER_CLASS = "relative overflow-auto rounded-xl";
export const SEASON_VIEW_TOGGLE_CLASS =
	"inline-flex shrink-0 overflow-hidden rounded-lg border";

// roster.tsx
export const ROSTER_STATS_GRID_CLASS =
	"mb-6 grid grid-cols-[repeat(auto-fit,minmax(168px,1fr))] gap-3";
export const ROSTER_FILTER_ROW_CLASS = "mb-4 flex flex-wrap items-center gap-2";
export const ROSTER_TABLE_CLASS =
	"overflow-hidden rounded-2xl border border-border bg-surface-raised";
export const ROSTER_HEADER_ROW_CLASS =
	"grid gap-3.5 border-b border-border bg-surface-soft px-5 py-3";
export const ROSTER_ROW_CLASS =
	"grid items-center gap-3.5 border-b border-border px-5 py-3 last:border-b-0";
export const ROSTER_TABLE_GRID =
	"grid-cols-[1fr_34px] sm:grid-cols-[1fr_150px_170px_34px] xl:grid-cols-[1fr_150px_170px_150px_34px]";

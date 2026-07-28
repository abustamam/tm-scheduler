/**
 * Every Base Camp host the sync must run on.
 *
 * ONE list, imported by both content scripts and by `wxt.config.ts`'s
 * `host_permissions`. It used to be three hand-maintained copies, which is
 * exactly how `apps.basecamp.toastmasters.org` came to be missing: TI serves the
 * Pathways dashboard from a host nobody here had heard of, the content scripts
 * never injected, and the sync widget simply didn't appear — no button, no
 * error, nothing to debug.
 *
 * `apps.` (plural) is where the dashboard lives now:
 *   https://apps.basecamp.toastmasters.org/dashboard/bcm-dashboard/paths-progress
 *
 * The API is NOT on that host — it stays at bare `basecamp.toastmasters.org`
 * (`/api/bcm/progress/?club=…`), which is why `basecamp-walk.ts` and
 * `basecamp-detail-walk.ts` keep their hard-coded base and why the bare host
 * must remain in `host_permissions`: from the `apps.` page the walk is a
 * CROSS-ORIGIN credentialed fetch, not the same-origin one the walk was
 * originally written for. Base Camp evidently permits it — the dashboard page
 * itself makes that same cross-origin call to render — but it is a real change
 * in what the walk depends on, so it is called out rather than assumed.
 */
export const BASECAMP_MATCHES = [
	"https://basecamp.toastmasters.org/*",
	"https://app.basecamp.toastmasters.org/*",
	"https://apps.basecamp.toastmasters.org/*",
] as const;

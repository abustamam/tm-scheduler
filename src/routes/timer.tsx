import { createFileRoute } from "@tanstack/react-router";
import { MarketingShell } from "#/components/marketing/marketing-shell";
import { StandaloneTimer } from "#/components/timer/standalone-timer";
import { shareMeta } from "#/lib/share-meta";

const TITLE = "Toastmasters timer: free green, yellow and red stopwatch";
const DESCRIPTION =
	"A plain Toastmasters timer for any speech: presets for the Ice Breaker, speeches, Table Topics and evaluations, or your own marks. No sign-in.";

// Public (#1248): no loader, no server function, no club. The page's state
// lives in the browser, and `timer-route.guard.test.ts` pins that this module's
// import graph reaches neither `#/server/timings` nor `#/db`.
export const Route = createFileRoute("/timer")({
	head: () => ({
		meta: [
			...shareMeta({ title: TITLE, description: DESCRIPTION, path: "/timer" }),
		],
	}),
	component: TimerPage,
});

function TimerPage() {
	return (
		<MarketingShell>
			<StandaloneTimer />
		</MarketingShell>
	);
}

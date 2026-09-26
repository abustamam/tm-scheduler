import { createFileRoute } from "@tanstack/react-router";
import { ResourcesShell } from "#/components/resources/resources-shell";
import { WhatsNewPublicList } from "#/components/whats-new-panel";
import { getAuthContext } from "#/server/auth-context";

const TITLE = "What's new in GavelUp";
const DESCRIPTION =
	"The latest additions to GavelUp, the meeting sign-up and agenda app for Toastmasters clubs.";

export const Route = createFileRoute("/whats-new")({
	// Public. A signed-in user with a club gets the app shell, like /resources.
	beforeLoad: async () => {
		const ctx = await getAuthContext();
		const shell = !!ctx.user && ctx.clubs.length > 0;
		return { shell, authCtx: shell ? ctx : null };
	},
	head: () => ({
		meta: [
			{ title: TITLE },
			{ name: "description", content: DESCRIPTION },
			{ property: "og:title", content: TITLE },
			{ property: "og:description", content: DESCRIPTION },
			{ property: "og:type", content: "website" },
		],
	}),
	component: WhatsNewPage,
});

function WhatsNewPage() {
	const { shell, authCtx } = Route.useRouteContext();
	return (
		<ResourcesShell shell={shell} authCtx={authCtx}>
			<div className="mb-6 pt-2">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					What's new
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					The latest additions to GavelUp, newest first.
				</p>
			</div>
			<WhatsNewPublicList />
		</ResourcesShell>
	);
}

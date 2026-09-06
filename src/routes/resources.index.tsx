import { createFileRoute } from "@tanstack/react-router";
import { ResourceCatalog } from "#/components/resources/resource-catalog";
import { ResourcesShell } from "#/components/resources/resources-shell";
import { getAuthContext } from "#/server/auth-context";

const TITLE = "Toastmasters resources — GavelUp";
const DESCRIPTION =
	"What to expect at a Toastmasters meeting, what each role does, and printable role sheets.";

export const Route = createFileRoute("/resources/")({
	// #317: a signed-in user with a club sees the resources page inside the app
	// shell (so "Resources" in the sidebar keeps them oriented); anonymous
	// visitors get the lightweight header. getAuthContext is fast for anon.
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
	component: ResourcesIndex,
});

function ResourcesIndex() {
	const { shell, authCtx } = Route.useRouteContext();
	return (
		<ResourcesShell shell={shell} authCtx={authCtx}>
			<div className="mb-6 pt-2">
				<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
					Toastmasters resources
				</h1>
				<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
					What to expect at a meeting, what each role does, and printable sheets
					you can bring along.
				</p>
			</div>
			{/* Cards + the category filter (#313). Rendered as <ResourcesShell>'s
			    CHILD, which is what makes the filter reach both shell branches: the
			    shell picks the app sidebar or the light header around exactly this
			    subtree. Keeping it a child rather than duplicating it per branch is
			    pinned by resources-index-catalog.guard.test.ts. */}
			<ResourceCatalog />
		</ResourcesShell>
	);
}

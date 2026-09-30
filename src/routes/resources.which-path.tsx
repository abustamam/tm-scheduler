import { createFileRoute } from "@tanstack/react-router";
import { PathQuiz } from "#/components/pathways/path-quiz";
import { ResourcesShell } from "#/components/resources/resources-shell";
import { getAuthContext } from "#/server/auth-context";

const TITLE = "Which Pathways path? — GavelUp";
const DESCRIPTION =
	"Seven quick questions that suggest a Toastmasters Pathways path to start with. You can always choose a different one.";

/**
 * The path-selection quiz (#935). Public: no sign-in, and nothing about the
 * visitor is read beyond whether they are signed in, which decides only
 * whether each result offers "Use this path". The quiz itself runs in the
 * browser (`PathQuiz`) and sends no answer to the server.
 */
export const Route = createFileRoute("/resources/which-path")({
	// Mirrors resources.index.tsx: a signed-in member with a club gets the app
	// shell, an anonymous visitor the light header.
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
	component: WhichPath,
});

function WhichPath() {
	const { shell, authCtx } = Route.useRouteContext();
	return (
		<ResourcesShell shell={shell} authCtx={authCtx}>
			<div className="mx-auto max-w-2xl">
				<div className="mb-6 pt-2">
					<h1 className="font-display text-3xl font-semibold tracking-[-0.02em]">
						Which path should I start with?
					</h1>
					<p className="mt-1 text-sm text-[var(--sea-ink-soft)]">
						Answer a few questions about what you want out of Toastmasters and
						we'll suggest a path or two. It's only a starting point: there's no
						wrong choice, and you can pick any path you like. Your answers stay
						in your browser.
					</p>
				</div>
				{/* "Use this path" goes to the dashboard picker, so it needs a
				    member with a club — exactly `shell`. */}
				<PathQuiz signedIn={shell} />
			</div>
		</ResourcesShell>
	);
}

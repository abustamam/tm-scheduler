import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { shareMeta } from "#/lib/share-meta";
import { InstallHint } from "../components/install-hint";
import { RouteProgress } from "../components/route-progress";
import { ServiceWorkerManager } from "../components/service-worker-manager";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			...shareMeta({
				title: "GavelUp",
				description:
					"Meeting scheduling, roles and agendas for Toastmasters clubs.",
			}),
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
			{
				rel: "icon",
				href: "/favicon.svg",
				type: "image/svg+xml",
			},
			{
				rel: "icon",
				href: "/favicon.ico",
				sizes: "any",
			},
			{
				rel: "apple-touch-icon",
				href: "/logo192.png",
			},
			{ rel: "manifest", href: "/manifest.json" },
		],
	}),
	shellComponent: RootDocument,
});

// Rendered straight into <head>, NOT through head().meta: HeadContent
// de-duplicates metas by `name`, ignoring `media`, so two theme-color entries
// collapse to one and the light one was dropped (#1463).
function ThemeColorMetas() {
	return (
		<>
			<meta
				name="theme-color"
				content="#f3faf5"
				media="(prefers-color-scheme: light)"
			/>
			<meta
				name="theme-color"
				content="#0a1418"
				media="(prefers-color-scheme: dark)"
			/>
		</>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		// suppressHydrationWarning: the theme script below adds `.dark` to <html>
		// before hydration, so the client attribute legitimately differs from the
		// SSR markup; without it React reconciles the class away (dark-mode flash)
		// and logs a mismatch on every navigation.
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* Apply the saved theme before paint to avoid a flash of the wrong mode. */}
				<script
					// biome-ignore lint/security/noDangerouslySetInnerHtml: tiny, static, no user input
					dangerouslySetInnerHTML={{
						__html: `(function(){try{var t=localStorage.getItem('gavelup-theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();`,
					}}
				/>
				<ThemeColorMetas />
				<HeadContent />
			</head>
			<body>
				<RouteProgress />
				{children}
				<ServiceWorkerManager />
				<InstallHint />
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						TanStackQueryDevtools,
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}

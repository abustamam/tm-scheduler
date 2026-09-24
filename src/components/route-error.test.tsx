// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteError } from "./route-error";

// Both strings would be on screen under TanStack's default error component
// (its "Show Error" panel is open by default outside production). Neither may
// reach a member: a server-fn failure can carry SQL, ids or someone's name.
const SECRET = "relation meeting_slots violates constraint sk_42";
const STACK_MARKER = "at loadMeetingAgenda";

function secretError() {
	const err = new Error(SECRET);
	err.stack = `Error: ${SECRET}\n    ${STACK_MARKER} (src/server/agenda.ts:12:3)`;
	return err;
}

/**
 * A real router whose `/club/$clubId/boom` loader throws on its first `fails`
 * calls, wired exactly as `src/router.tsx` wires the app: `RouteError` as the
 * DEFAULT error component, not a per-route one.
 */
function makeRouter(opts: {
	fails: number;
	isServer?: boolean;
	renderFails?: { now: boolean };
	/** Initial URL; the club agenda by default. */
	at?: string;
}) {
	let calls = 0;
	function ThrowsOnRender() {
		if (opts.renderFails?.now) throw secretError();
		return <p>Rendered fine</p>;
	}
	const loader = vi.fn(() => {
		calls += 1;
		if (calls <= opts.fails) throw secretError();
		return { ok: true };
	});
	const rootRoute = createRootRoute({
		component: () => (
			<div>
				<nav>App shell nav</nav>
				<Outlet />
			</div>
		),
	});
	const homeRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => <p>Home page</p>,
	});
	const clubRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/club/$clubId",
		component: () => <p>Club page</p>,
	});
	const boomRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/club/$clubId/boom",
		loader,
		component: () => <p>Agenda loaded</p>,
	});
	const plainBoomRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/boom",
		loader,
		component: () => <p>Agenda loaded</p>,
	});
	const ssrRenderBoomRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/club/$clubId/render-boom",
		component: function AlwaysThrows(): never {
			throw secretError();
		},
	});
	const renderBoomRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/render-boom",
		component: ThrowsOnRender,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([
			homeRoute,
			clubRoute,
			boomRoute,
			plainBoomRoute,
			renderBoomRoute,
			ssrRenderBoomRoute,
		]),
		history: createMemoryHistory({
			initialEntries: [opts.at ?? "/club/thr/boom"],
		}),
		defaultErrorComponent: RouteError,
		isServer: opts.isServer,
	});
	return { router, loader };
}

function expectNoLeak(text: string) {
	expect(text).not.toContain(SECRET);
	expect(text).not.toContain(STACK_MARKER);
	expect(text).not.toMatch(/Something went wrong!/);
	expect(text).not.toMatch(/Show Error/);
}

describe("RouteError (#878)", () => {
	let consoleError: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("renders the branded page, inside the shell, with no message or stack", async () => {
		const { router } = makeRouter({ fails: Number.POSITIVE_INFINITY });
		const { container } = render(<RouterProvider router={router} />);

		expect(await screen.findByText("Something went wrong")).toBeTruthy();
		expect(screen.getByText(/This page couldn't load/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
		// The failing route's parent layout still drew around it.
		expect(screen.getByText("App shell nav")).toBeTruthy();
		// The brand frame shared with the 404.
		expect(screen.getAllByText("GavelUp").length).toBeGreaterThan(0);
		expectNoLeak(container.textContent ?? "");
		expectNoLeak(container.innerHTML);
	});

	it("still sends the error to the console for debugging", async () => {
		const { router } = makeRouter({ fails: Number.POSITIVE_INFINITY });
		render(<RouterProvider router={router} />);
		await screen.findByText("Something went wrong");
		await waitFor(() =>
			expect(
				consoleError.mock.calls.some(
					(args: unknown[]) =>
						args[0] === "[route-error]" &&
						args[1] instanceof Error &&
						args[1].message === SECRET,
				),
			).toBe(true),
		);
	});

	it("Try again re-runs the loader and shows the page once it succeeds", async () => {
		const { router, loader } = makeRouter({ fails: 1 });
		render(<RouterProvider router={router} />);
		await screen.findByText("Something went wrong");
		const before = loader.mock.calls.length;

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		});

		expect(await screen.findByText("Agenda loaded")).toBeTruthy();
		expect(loader.mock.calls.length).toBeGreaterThan(before);
		expect(screen.queryByText("Something went wrong")).toBeNull();
	});

	it("Try again also recovers from a RENDER error, not only a loader error", async () => {
		// A flag rather than a count: React retries a throwing render an
		// unspecified number of times before handing it to the boundary.
		const renderFails = { now: true };
		const { router } = makeRouter({
			fails: 0,
			renderFails,
			at: "/render-boom",
		});
		const { container } = render(<RouterProvider router={router} />);
		await screen.findByText("Something went wrong");
		expectNoLeak(container.textContent ?? "");

		renderFails.now = false;
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		});

		expect(await screen.findByText("Rendered fine")).toBeTruthy();
		expect(screen.queryByText("Something went wrong")).toBeNull();
	});

	it("offers Back to club BESIDE Go home on a club route, never instead of it", async () => {
		// When the club layout or the club page is what failed, "Back to club" is
		// the page that just errored; "Go home" must still be there as the way out.
		const { router } = makeRouter({ fails: Number.POSITIVE_INFINITY });
		render(<RouterProvider router={router} />);
		const club = await screen.findByRole("link", { name: "Back to club" });
		expect(club.getAttribute("href")).toBe("/club/thr?view=roles&count=8");
		const home = screen.getByRole("link", { name: "Go home" });
		expect(home.getAttribute("href")).toBe("/");
	});

	it("offers only Go home when there is no club in the URL", async () => {
		const { router } = makeRouter({
			fails: Number.POSITIVE_INFINITY,
			at: "/boom",
		});
		render(<RouterProvider router={router} />);
		const link = await screen.findByRole("link", { name: "Go home" });
		expect(link.getAttribute("href")).toBe("/");
		expect(screen.queryByRole("link", { name: "Back to club" })).toBeNull();
	});

	it("renders on CLIENT NAVIGATION from a working page to one that throws", async () => {
		const { router } = makeRouter({
			fails: Number.POSITIVE_INFINITY,
			at: "/",
		});
		const { container } = render(<RouterProvider router={router} />);
		expect(await screen.findByText("Home page")).toBeTruthy();

		await act(async () => {
			await router.navigate({
				to: "/club/$clubId/boom" as never,
				params: { clubId: "thr" } as never,
			});
		});

		expect(await screen.findByText("Something went wrong")).toBeTruthy();
		expect(screen.queryByText("Home page")).toBeNull();
		expect(screen.getByText("App shell nav")).toBeTruthy();
		expectNoLeak(container.textContent ?? "");
	});

	it("renders on the server too, with no message or stack, and logs it there", async () => {
		const { router } = makeRouter({
			fails: Number.POSITIVE_INFINITY,
			isServer: true,
		});
		await router.load();
		const html = renderToString(<RouterProvider router={router} />);

		expect(html).toContain("Something went wrong");
		expect(html).toContain("Try again");
		expect(html).toContain("App shell nav");
		expectNoLeak(html);
		expect(
			consoleError.mock.calls.some(
				(args: unknown[]) =>
					args[0] === "[route-error]" &&
					args[1] instanceof Error &&
					args[1].message === SECRET,
			),
		).toBe(true);
	});
});

describe("a route COMPONENT that throws during SSR (#878 review)", () => {
	let consoleError: ReturnType<typeof vi.spyOn>;
	let root: Root | undefined;
	beforeEach(() => {
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		act(() => root?.unmount());
		root = undefined;
		document.body.innerHTML = "";
		vi.restoreAllMocks();
	});

	it("streams an empty boundary on the server, then hydrates into the branded page", async () => {
		// React has no server-side error boundaries: a component that throws while
		// streaming leaves its Suspense boundary empty (`<!--$!-->`) and marks it
		// for client rendering, so the server CANNOT render RouteError here — a
		// loader error it can (the SSR test above). What the member must get is
		// the branded page once the client takes over, not a blank page and not
		// TanStack's default. `renderToReadableStream` is what TanStack Start's
		// `renderRouterToStream` calls.
		const server = makeRouter({
			fails: 0,
			isServer: true,
			at: "/club/thr/render-boom",
		}).router;
		await server.load();
		const stream = await renderToReadableStream(
			<RouterProvider router={server} />,
			{ onError: () => {} },
		);
		await stream.allReady;
		const html = await new Response(stream).text();
		expect(html).toContain("App shell nav");
		expect(html).toContain("<!--$!-->");
		expect(html).not.toContain("Something went wrong");

		const container = document.createElement("div");
		container.innerHTML = html;
		document.body.appendChild(container);
		const client = makeRouter({ fails: 0, at: "/club/thr/render-boom" }).router;
		await client.load();
		await act(async () => {
			root = hydrateRoot(container, <RouterProvider router={client} />, {
				onRecoverableError: () => {},
			});
		});

		await waitFor(() =>
			expect(container.textContent).toContain("Something went wrong"),
		);
		expect(container.textContent).toContain("Try again");
		expect(container.textContent).toContain("Go home");
		expect(container.textContent).toContain("App shell nav");
		// No SSR copy of RouteError ran, so the browser-side log is the only one.
		await waitFor(() =>
			expect(
				consoleError.mock.calls.some(
					(args: unknown[]) =>
						args[0] === "[route-error]" &&
						args[1] instanceof Error &&
						args[1].message === SECRET,
				),
			).toBe(true),
		);
		// React's dev build writes the message into the fallback's <template>; the
		// hydrated page must not keep it (the production stream never carries it).
		expectNoLeak(container.textContent ?? "");
		expectNoLeak(container.innerHTML);
	});
});

describe("router wiring (#878)", () => {
	it("sets RouteError as the app router's defaultErrorComponent", () => {
		// `getRouter` pulls in the whole route tree (and `pg` through it), so the
		// wiring is pinned by source; the behaviour it wires is pinned above.
		const src = readFileSync(resolve(__dirname, "../router.tsx"), "utf8");
		expect(src).toMatch(/^\s*defaultErrorComponent:\s*RouteError,\s*$/m);
		expect(src).toMatch(
			/^import \{ RouteError \} from "\.\/components\/route-error";$/m,
		);
	});
});

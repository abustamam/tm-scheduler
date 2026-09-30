// @vitest-environment jsdom
/**
 * The dashboard's new-member checklist (#940), driven the way a member drives
 * it. The derivation is `#/lib/orientation` (tested there); this pins what the
 * card renders from a view and which callbacks its controls fire.
 */
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MY_PATHWAYS_ANCHOR } from "#/lib/my-pathways-anchor";
import {
	type OrientationFacts,
	orientationView,
	PATHWAYS_EXPLAINER_HREF,
} from "#/lib/orientation";
import { PATH_QUIZ_HREF, PATH_QUIZ_LINK_LABEL } from "#/lib/path-quiz";
import {
	ORIENTATION_DISMISS_LABEL,
	ORIENTATION_HEADING,
	ORIENTATION_LEARN_LABEL,
	OrientationChecklist,
} from "./orientation-checklist";

afterEach(cleanup);

const facts = (over: Partial<OrientationFacts> = {}): OrientationFacts => ({
	startedAt: new Date("2026-09-01T00:00:00Z"),
	dismissedAt: null,
	basecampSetupAt: null,
	activePathCount: 0,
	slots: [],
	menteePairings: [],
	...over,
});

const mentorPairing = (
	over: Partial<OrientationFacts["menteePairings"][number]> = {},
): OrientationFacts["menteePairings"][number] => ({
	focus: "new_member",
	endedAt: null,
	mentorName: "Maya Mentor",
	mentorEmail: "maya@example.test",
	mentorPhone: "+15555550100",
	...over,
});

async function renderCard(
	f: OrientationFacts | null,
	handlers: {
		onToggleBaseCamp?: (done: boolean) => Promise<void>;
		onDismiss?: () => Promise<void>;
	} = {},
) {
	const onToggleBaseCamp =
		handlers.onToggleBaseCamp ?? vi.fn(async () => undefined);
	const onDismiss = handlers.onDismiss ?? vi.fn(async () => undefined);
	const rootRoute = createRootRoute({
		// The sentinel proves the tree mounted, so "renders nothing" below is
		// the card's answer and not an empty router.
		component: () => (
			<>
				<span data-testid="mounted" />
				<OrientationChecklist
					view={f ? orientationView(f) : null}
					onToggleBaseCamp={onToggleBaseCamp}
					onDismiss={onDismiss}
				/>
			</>
		),
	});
	rootRoute.addChildren([
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/resources/$slug",
			component: () => null,
		}),
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/next",
			component: () => null,
		}),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const { container } = render(<RouterProvider router={router} />);
	await router.load();
	return { container, onToggleBaseCamp, onDismiss };
}

describe("OrientationChecklist (#940)", () => {
	it("renders nothing for a veteran, a dismissed or a finished checklist", async () => {
		for (const f of [
			null,
			facts({ startedAt: null }),
			facts({ dismissedAt: new Date() }),
			facts({
				activePathCount: 1,
				basecampSetupAt: new Date(),
				slots: [
					{ isSpeakerRole: true, meetingStatus: "scheduled" },
					{ isSpeakerRole: false, meetingStatus: "completed" },
				],
				menteePairings: [mentorPairing()],
			}),
		]) {
			const { container } = await renderCard(f);
			expect(await screen.findByTestId("mounted")).toBeTruthy();
			expect(container.querySelector("section")).toBeNull();
			expect(container.textContent).not.toContain(ORIENTATION_HEADING);
			cleanup();
		}
	});

	it("shows the five items, the count, and only Base Camp as a checkbox", async () => {
		const { container } = await renderCard(facts({ activePathCount: 1 }));
		expect(await screen.findByText(ORIENTATION_HEADING)).toBeTruthy();
		expect(screen.getByText("1 of 5 done")).toBeTruthy();
		const items = container.querySelectorAll("li[data-item]");
		expect([...items].map((i) => i.getAttribute("data-item"))).toEqual([
			"choose-path",
			"ice-breaker",
			"supporting-role",
			"base-camp",
			"get-a-mentor",
		]);
		const boxes = screen.getAllByRole("checkbox");
		expect(boxes).toHaveLength(1);
		expect(screen.getByLabelText("Set up Base Camp")).toBe(boxes[0]);
		expect(
			container
				.querySelector('li[data-item="choose-path"]')
				?.getAttribute("data-done"),
		).toBe("true");
	});

	it("links each unfinished item to where it gets done", async () => {
		const { container } = await renderCard(facts());
		await screen.findByText(ORIENTATION_HEADING);
		const href = (key: string) =>
			container.querySelector(`li[data-item="${key}"] a`)?.getAttribute("href");
		expect(href("choose-path")).toBe(`#${MY_PATHWAYS_ANCHOR}`);
		expect(href("ice-breaker")).toBe("/next");
		expect(href("supporting-role")).toBe("/next");
		expect(href("base-camp")).toBe(`${PATHWAYS_EXPLAINER_HREF}#base-camp`);
		expect(
			screen
				.getByRole("link", { name: ORIENTATION_LEARN_LABEL })
				.getAttribute("href"),
		).toBe(PATHWAYS_EXPLAINER_HREF);
	});

	it("Choose a path also links to the path quiz (#935), until a path is chosen", async () => {
		const { container } = await renderCard(facts());
		await screen.findByText(ORIENTATION_HEADING);
		const li = container.querySelector('li[data-item="choose-path"]');
		const quiz = [...(li?.querySelectorAll("a") ?? [])].find(
			(a) => a.textContent === PATH_QUIZ_LINK_LABEL,
		);
		expect(quiz?.getAttribute("href")).toBe(PATH_QUIZ_HREF);
		cleanup();

		const done = await renderCard(facts({ activePathCount: 1 }));
		await screen.findByText(ORIENTATION_HEADING);
		expect(
			done.container.querySelector('li[data-item="choose-path"] a'),
		).toBeNull();
	});

	it("Get a mentor has no action while undone, and names nobody", async () => {
		const { container } = await renderCard(facts());
		await screen.findByText(ORIENTATION_HEADING);
		const li = container.querySelector('li[data-item="get-a-mentor"]');
		expect(li?.getAttribute("data-done")).toBe("false");
		expect(li?.querySelector("a")).toBeNull();
		expect(li?.querySelector('[data-slot="mentor-contacts"]')).toBeNull();
	});

	it("Get a mentor, once ticked, shows the mentor's name and contact (#939)", async () => {
		const { container } = await renderCard(
			facts({ menteePairings: [mentorPairing()] }),
		);
		await screen.findByText(ORIENTATION_HEADING);
		const li = container.querySelector('li[data-item="get-a-mentor"]');
		expect(li?.getAttribute("data-done")).toBe("true");
		expect(li?.textContent).toContain("Your mentor: Maya Mentor");
		const hrefs = [...(li?.querySelectorAll("a") ?? [])].map((a) =>
			a.getAttribute("href"),
		);
		expect(hrefs).toContain("mailto:maya@example.test");
		expect(hrefs.some((h) => h?.includes("15555550100"))).toBe(true);
	});

	it("an ended new-member pairing or an active contest pairing does not tick it", async () => {
		const { container } = await renderCard(
			facts({
				menteePairings: [
					mentorPairing({ endedAt: new Date("2026-09-10T00:00:00Z") }),
					mentorPairing({ focus: "contest", mentorName: "Contest Coach" }),
				],
			}),
		);
		await screen.findByText(ORIENTATION_HEADING);
		const li = container.querySelector('li[data-item="get-a-mentor"]');
		expect(li?.getAttribute("data-done")).toBe("false");
		expect(container.textContent).not.toContain("Maya Mentor");
		expect(container.textContent).not.toContain("Contest Coach");
	});

	it("drops the action from a finished item", async () => {
		const { container } = await renderCard(facts({ activePathCount: 1 }));
		await screen.findByText(ORIENTATION_HEADING);
		expect(container.querySelector('li[data-item="choose-path"] a')).toBeNull();
	});

	it("ticking Base Camp calls onToggleBaseCamp(true); unticking calls it with false", async () => {
		const user = userEvent.setup();
		const { onToggleBaseCamp } = await renderCard(facts());
		await user.click(await screen.findByLabelText("Set up Base Camp"));
		expect(onToggleBaseCamp).toHaveBeenCalledWith(true);
		cleanup();
		const again = await renderCard(facts({ basecampSetupAt: new Date() }));
		await user.click(await screen.findByLabelText("Set up Base Camp"));
		expect(again.onToggleBaseCamp).toHaveBeenCalledWith(false);
	});

	it("I'm all set calls onDismiss", async () => {
		const user = userEvent.setup();
		const { onDismiss } = await renderCard(facts());
		await user.click(
			await screen.findByRole("button", { name: ORIENTATION_DISMISS_LABEL }),
		);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});

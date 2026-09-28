// @vitest-environment jsdom
//
// The public feedback page (#984): its loader's not-found and window states,
// and the send flow down to the "Sent ✓" reminder. Same harness as the ballot
// route's test — the server fns and the club resolver are mocked, because all
// of them reach `#/db` → `pg`, which must not load here.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	isNotFound,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));
vi.mock("#/server/role-feedback", () => ({
	getFeedbackTargetsPublic: vi.fn(),
	leaveFeedback: vi.fn(),
}));

import { resolveClubOrRedirect } from "#/lib/club-route";
import type { FeedbackTargetsPublic } from "#/server/role-feedback";
import {
	getFeedbackTargetsPublic,
	leaveFeedback,
} from "#/server/role-feedback";
import { Route } from "./club.$clubId_.meeting.$meetingId.feedback";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEETING_ID = "22222222-2222-4222-8222-222222222222";
const SLOT_ID = "33333333-3333-4333-8333-333333333333";
const TT_ID = "44444444-4444-4444-8444-444444444444";
const location = { href: "/club/downtown/meeting/2026-10-03/feedback" };
const params = { clubId: "downtown", meetingId: "2026-10-03" };

// biome-ignore lint/suspicious/noExplicitAny: route loaders take a router ctx
function runLoader(): Promise<any> {
	// biome-ignore lint/suspicious/noExplicitAny: loader union has no call sig
	return (Route.options as any).loader({ params, location });
}

function payload(
	window: Partial<FeedbackTargetsPublic["window"]> = {},
): FeedbackTargetsPublic {
	const now = Date.now();
	return {
		meeting: {
			id: MEETING_ID,
			date: new Date(now - 10 * 60_000).toISOString(),
			title: "Autumn",
			timezone: "America/Chicago",
		},
		window: {
			opensAt: new Date(now - 10 * 60_000).toISOString(),
			endsAt: new Date(now + 80 * 60_000).toISOString(),
			closesAt: new Date(now + 3 * 86_400_000).toISOString(),
			canWrite: true,
			recipientsCanRead: false,
			...window,
		},
		targets: [
			{ kind: "slot", id: SLOT_ID, memberName: "Pat Lee", roleLabel: "Timer" },
			{
				kind: "tableTopics",
				id: TT_ID,
				memberName: "Sam Ortiz",
				roleLabel: "Table Topics speaker",
			},
		],
	};
}

beforeEach(() => {
	localStorage.clear();
	vi.mocked(resolveClubOrRedirect).mockResolvedValue({
		id: CLUB_ID,
		slug: "downtown",
		name: "Downtown Toastmasters",
		clubNumber: "123456",
		// biome-ignore lint/suspicious/noExplicitAny: partial club is enough
	} as any);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("feedback route loader (#984)", () => {
	it("404s when the server has no page for it (archived, cancelled, unknown)", async () => {
		vi.mocked(getFeedbackTargetsPublic).mockResolvedValue(null);
		await expect(runLoader()).rejects.toSatisfy(isNotFound);
		expect(getFeedbackTargetsPublic).toHaveBeenCalledWith({
			data: { clubId: CLUB_ID, meetingKey: "2026-10-03" },
		});
	});

	it("is open while the server says canWrite", async () => {
		vi.mocked(getFeedbackTargetsPublic).mockResolvedValue(payload());
		expect((await runLoader()).state).toBe("open");
	});

	it("is notYet before the meeting starts, closed after the window", async () => {
		const later = new Date(Date.now() + 86_400_000).toISOString();
		vi.mocked(getFeedbackTargetsPublic).mockResolvedValue(
			payload({ canWrite: false, opensAt: later }),
		);
		expect((await runLoader()).state).toBe("notYet");

		vi.mocked(getFeedbackTargetsPublic).mockResolvedValue(
			payload({
				canWrite: false,
				opensAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
			}),
		);
		expect((await runLoader()).state).toBe("closed");
	});

	it("is not indexed", () => {
		// biome-ignore lint/suspicious/noExplicitAny: head() takes a router ctx
		const head = (Route.options as any).head();
		expect(head.meta).toContainEqual({
			name: "robots",
			content: "noindex, nofollow",
		});
	});
});

async function renderPage(state: "open" | "notYet" | "closed") {
	const data = payload();
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		clubName: "Downtown Toastmasters",
		clubNumber: "123456",
		meeting: data.meeting,
		targets: data.targets,
		state,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const rootRoute = createRootRoute({
		component: () => (
			<QueryClientProvider client={qc}>
				<Component />
			</QueryClientProvider>
		),
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	render(<RouterProvider router={router} />);
	await waitFor(() => expect(router.state.status).toBe("idle"));
}

describe("feedback page (#984)", () => {
	it("lists each target as a card with name and role", async () => {
		await renderPage("open");
		const pat = await screen.findByRole("button", { name: /Pat Lee.*Timer/ });
		expect(pat).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /Sam Ortiz.*Table Topics speaker/ }),
		).toBeTruthy();
	});

	it("shows the not-yet-open and closed copy instead of the cards", async () => {
		await renderPage("notYet");
		expect((await screen.findByTestId("feedback-state")).textContent).toBe(
			"Feedback opens when the meeting starts.",
		);
		expect(screen.queryByRole("button", { name: /Pat Lee/ })).toBeNull();
		cleanup();

		await renderPage("closed");
		expect((await screen.findByTestId("feedback-state")).textContent).toBe(
			"Feedback for this meeting has closed.",
		);
		expect(screen.queryByRole("button", { name: /Pat Lee/ })).toBeNull();
	});

	it("sends a note and marks the card Sent ✓ on this device, still tappable", async () => {
		vi.mocked(leaveFeedback).mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		await renderPage("open");
		await user.click(await screen.findByRole("button", { name: /Pat Lee/ }));

		expect(
			screen.getByText(
				"Don't write anything you wouldn't say to them in person.",
			),
		).toBeTruthy();
		const send = screen.getByRole("button", { name: "Send anonymously" });
		// At least one box is required.
		expect((send as HTMLButtonElement).disabled).toBe(true);

		await user.type(screen.getByLabelText("What went well"), "Crisp signals");
		expect(screen.getByText("13/500")).toBeTruthy();
		await user.click(send);

		await waitFor(() =>
			expect(leaveFeedback).toHaveBeenCalledWith({
				data: {
					meetingId: MEETING_ID,
					target: { kind: "slot", id: SLOT_ID },
					wentWell: "Crisp signals",
					tryNext: "",
				},
			}),
		);
		const card = await screen.findByRole("button", { name: /Pat Lee.*Sent/ });
		expect(card).toBeTruthy();
		// The other card is untouched.
		expect(
			screen.queryByRole("button", { name: /Sam Ortiz.*Sent/ }),
		).toBeNull();
		expect(
			JSON.parse(
				localStorage.getItem(`gavelup:feedback-sent:${MEETING_ID}`) ?? "[]",
			),
		).toEqual([`slot:${SLOT_ID}`]);

		// Only a reminder: the card opens the form again.
		await user.click(card);
		expect(
			screen.getByRole("button", { name: "Send anonymously" }),
		).toBeTruthy();
	});

	it("keeps the Sent ✓ mark across a reload of the page", async () => {
		localStorage.setItem(
			`gavelup:feedback-sent:${MEETING_ID}`,
			JSON.stringify([`tableTopics:${TT_ID}`]),
		);
		await renderPage("open");
		expect(
			await screen.findByRole("button", { name: /Sam Ortiz.*Sent/ }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Pat Lee.*Sent/ })).toBeNull();
	});

	it("shows the server's refusal and does not mark the card sent", async () => {
		vi.mocked(leaveFeedback).mockRejectedValue(
			new Error("Feedback for this meeting has closed."),
		);
		const user = userEvent.setup();
		await renderPage("open");
		await user.click(await screen.findByRole("button", { name: /Pat Lee/ }));
		await user.type(screen.getByLabelText("One thing to try"), "Slow down");
		await user.click(screen.getByRole("button", { name: "Send anonymously" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Feedback for this meeting has closed.",
		);
		expect(
			localStorage.getItem(`gavelup:feedback-sent:${MEETING_ID}`),
		).toBeNull();
	});

	it("refuses to send a box over 500 characters", async () => {
		const user = userEvent.setup();
		await renderPage("open");
		await user.click(await screen.findByRole("button", { name: /Pat Lee/ }));
		const box = screen.getByLabelText("What went well");
		await user.click(box);
		await user.paste("x".repeat(501));
		expect(screen.getByText("501/500")).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "Send anonymously",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});
});

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
const PAT = "55555555-5555-4555-8555-555555555555";
const SAM = "66666666-6666-4666-8666-666666666666";
const ROBIN = "77777777-7777-4777-8777-777777777777";
const CASEY = "88888888-8888-4888-8888-888888888888";
const TIMER_DEF = "99999999-9999-4999-8999-999999999999";
const SPEAKER_DEF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GRAM_DEF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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
			state: "open",
			...window,
		},
		targets: [
			{
				kind: "slot",
				id: SLOT_ID,
				memberName: "Pat Lee",
				roleLabel: "Timer",
				recipientMemberId: PAT,
				roleDefinitionId: TIMER_DEF,
				recipientActive: true,
			},
			{
				kind: "tableTopics",
				id: TT_ID,
				memberName: "Sam Ortiz",
				roleLabel: "Table Topics speaker",
				recipientMemberId: SAM,
				roleDefinitionId: null,
				recipientActive: true,
			},
		],
		others: [
			{ memberId: CASEY, name: "Casey Ng", preferredName: null },
			{ memberId: ROBIN, name: "Roberta Diaz", preferredName: "Robin" },
		],
		roleOptions: [
			{ roleDefinitionId: TIMER_DEF, name: "Timer" },
			{ roleDefinitionId: GRAM_DEF, name: "Grammarian" },
			{ roleDefinitionId: SPEAKER_DEF, name: "Speaker" },
		],
	};
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
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

	it("passes the server's window state straight through", async () => {
		for (const state of ["open", "notYet", "closed"] as const) {
			vi.mocked(getFeedbackTargetsPublic).mockResolvedValue(
				payload({ state, canWrite: state === "open" }),
			);
			expect((await runLoader()).state).toBe(state);
		}
	});

	it("never picks not-yet vs closed from the browser's clock", async () => {
		// The server says "notYet"; the instants, read on a (wrong) local clock,
		// would say closed. The server's answer wins.
		vi.useFakeTimers({ now: Date.now() + 30 * 86_400_000 });
		try {
			vi.mocked(getFeedbackTargetsPublic).mockResolvedValue(
				payload({ state: "notYet", canWrite: false }),
			);
			expect((await runLoader()).state).toBe("notYet");
		} finally {
			vi.useRealTimers();
		}
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

async function renderPage(
	state: "open" | "notYet" | "closed",
	edit: (p: FeedbackTargetsPublic) => FeedbackTargetsPublic = (p) => p,
) {
	const data = edit(payload());
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		clubName: "Downtown Toastmasters",
		clubNumber: "123456",
		meeting: data.meeting,
		targets: data.targets,
		others: data.others,
		roleOptions: data.roleOptions,
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

		// The current page always sends the person shape (#1021); only a tab
		// opened before that deploy sends `target`.
		await waitFor(() =>
			expect(leaveFeedback).toHaveBeenCalledWith({
				data: {
					meetingId: MEETING_ID,
					recipientMemberId: PAT,
					role: { kind: "slot", slotId: SLOT_ID },
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
				sessionStorage.getItem(`gavelup:feedback-sent:${MEETING_ID}`) ?? "[]",
			),
		).toEqual([PAT]);

		// Tab-scoped: nothing durable on a shared device says who wrote to whom.
		expect(localStorage.length).toBe(0);

		// Only a reminder: the card opens the form again.
		await user.click(card);
		expect(
			screen.getByRole("button", { name: "Send anonymously" }),
		).toBeTruthy();
	});

	it("still sends, and marks the card, when storage is refused", async () => {
		vi.mocked(leaveFeedback).mockResolvedValue({ ok: true });
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		const user = userEvent.setup();
		await renderPage("open");
		await user.click(await screen.findByRole("button", { name: /Pat Lee/ }));
		await user.type(screen.getByLabelText("What went well"), "Nice");
		await user.click(screen.getByRole("button", { name: "Send anonymously" }));
		expect(
			await screen.findByRole("button", { name: /Pat Lee.*Sent/ }),
		).toBeTruthy();
	});

	it("keeps the Sent ✓ mark across a reload in the same tab", async () => {
		sessionStorage.setItem(
			`gavelup:feedback-sent:${MEETING_ID}`,
			JSON.stringify([SAM]),
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
			sessionStorage.getItem(`gavelup:feedback-sent:${MEETING_ID}`),
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

const roleSelect = () => screen.getByLabelText("Role") as HTMLSelectElement;
const optionLabels = () =>
	Array.from(roleSelect().options).map((o) => o.textContent);

describe("feedback page — to a person (#1021)", () => {
	it("lists everyone else under Someone else, and the search filters by name or goes-by, any case (AC 9)", async () => {
		const user = userEvent.setup();
		await renderPage("open");
		const others = await screen.findByRole("list", { name: "Other members" });
		expect(others.textContent).toContain("Casey Ng");
		expect(others.textContent).toContain("Roberta Diaz");
		// Rows show the name, not a role.
		expect(others.textContent).not.toContain("Timer");

		const search = screen.getByRole("searchbox", { name: "Search members" });
		await user.type(search, "ROB");
		expect(others.textContent).toContain("Roberta Diaz");
		expect(others.textContent).not.toContain("Casey Ng");
		await user.clear(search);
		await user.type(search, "bin"); // inside "Robin", not in "Roberta Diaz"
		expect(others.textContent).toContain("Roberta Diaz");
		expect(others.textContent).not.toContain("Casey Ng");
		await user.clear(search);
		await user.type(search, "zzz");
		expect(screen.getByText("No one matches that name.")).toBeTruthy();
		// The agenda list is never filtered.
		expect(screen.getByRole("button", { name: /Pat Lee.*Timer/ })).toBeTruthy();
	});

	it("hides Someone else when there is no one else", async () => {
		await renderPage("open", (p) => ({ ...p, others: [] }));
		await screen.findByRole("button", { name: /Pat Lee/ });
		expect(screen.queryByText("Someone else")).toBeNull();
		expect(screen.queryByRole("searchbox")).toBeNull();
	});

	it("shows Someone else even when nobody holds a role yet", async () => {
		await renderPage("open", (p) => ({ ...p, targets: [] }));
		expect(
			await screen.findByRole("button", { name: /Casey Ng/ }),
		).toBeTruthy();
	});

	it("pre-selects the tapped role, and offers held roles, then the rest minus held definitions, TT speaker, General (AC 10)", async () => {
		const user = userEvent.setup();
		await renderPage("open", (p) => ({
			...p,
			targets: [
				...p.targets,
				{
					kind: "slot",
					id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
					memberName: "Pat Lee",
					roleLabel: "Speaker 2",
					recipientMemberId: PAT,
					roleDefinitionId: SPEAKER_DEF,
					recipientActive: true,
				},
			],
		}));
		await user.click(
			await screen.findByRole("button", { name: /Pat Lee.*Speaker 2/ }),
		);
		expect(optionLabels()).toEqual([
			"Timer",
			"Speaker 2",
			"Grammarian",
			"Table Topics speaker",
			"General",
		]);
		// Pre-set to the row that was tapped.
		expect(roleSelect().selectedOptions[0]?.textContent).toBe("Speaker 2");
	});

	it("a Table Topics speaker is not offered the bare TT speaker option twice", async () => {
		const user = userEvent.setup();
		await renderPage("open");
		await user.click(await screen.findByRole("button", { name: /Sam Ortiz/ }));
		expect(optionLabels()).toEqual([
			"Table Topics speaker",
			"Timer",
			"Grammarian",
			"Speaker",
			"General",
		]);
		expect(roleSelect().selectedOptions[0]?.textContent).toBe(
			"Table Topics speaker",
		);
	});

	it("an inactive recipient on the agenda is offered only the roles they hold (AC 10)", async () => {
		const user = userEvent.setup();
		await renderPage("open", (p) => ({
			...p,
			targets: p.targets.map((t) =>
				t.recipientMemberId === PAT ? { ...t, recipientActive: false } : t,
			),
		}));
		await user.click(await screen.findByRole("button", { name: /Pat Lee/ }));
		expect(optionLabels()).toEqual(["Timer"]);
	});

	it("from Someone else: no held roles, General pre-selected, and a changed role is what is sent", async () => {
		vi.mocked(leaveFeedback).mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		await renderPage("open");
		await user.click(await screen.findByRole("button", { name: /Casey Ng/ }));
		expect(optionLabels()).toEqual([
			"Timer",
			"Grammarian",
			"Speaker",
			"Table Topics speaker",
			"General",
		]);
		expect(roleSelect().value).toBe("general");
		await user.selectOptions(roleSelect(), "Grammarian");
		await user.type(screen.getByLabelText("What went well"), "Sharp");
		await user.click(screen.getByRole("button", { name: "Send anonymously" }));
		await waitFor(() =>
			expect(leaveFeedback).toHaveBeenCalledWith({
				data: {
					meetingId: MEETING_ID,
					recipientMemberId: CASEY,
					role: { kind: "definition", roleDefinitionId: GRAM_DEF },
					wentWell: "Sharp",
					tryNext: "",
				},
			}),
		);
	});

	it("marks every row for that person Sent, in both sections, whatever role was chosen (AC 11)", async () => {
		vi.mocked(leaveFeedback).mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		// Pat is on the agenda AND, for this test, also listed below.
		await renderPage("open", (p) => ({
			...p,
			others: [
				...p.others,
				{ memberId: PAT, name: "Pat Lee", preferredName: null },
			],
		}));
		const below = await screen.findByRole("list", { name: "Other members" });
		const patBelow = Array.from(below.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("Pat Lee"),
		) as HTMLButtonElement;
		await user.click(patBelow);
		expect(roleSelect().value).toBe("general");
		await user.type(screen.getByLabelText("What went well"), "Thanks");
		await user.click(screen.getByRole("button", { name: "Send anonymously" }));
		await waitFor(() =>
			expect(leaveFeedback).toHaveBeenCalledWith({
				data: expect.objectContaining({
					recipientMemberId: PAT,
					role: { kind: "general" },
				}),
			}),
		);
		const sent = await screen.findAllByRole("button", {
			name: /Pat Lee.*Sent/,
		});
		expect(sent).toHaveLength(2);
		expect(
			screen.queryByRole("button", { name: /Sam Ortiz.*Sent/ }),
		).toBeNull();
		expect(screen.queryByRole("button", { name: /Casey Ng.*Sent/ })).toBeNull();
	});

	it("sends exactly the option selected, after changing away from the tapped role and back", async () => {
		vi.mocked(leaveFeedback).mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		await renderPage("open");
		await user.click(await screen.findByRole("button", { name: /Pat Lee/ }));
		await user.selectOptions(roleSelect(), "General");
		expect(roleSelect().value).toBe("general");
		await user.selectOptions(roleSelect(), "Speaker");
		await user.selectOptions(roleSelect(), "Timer");
		expect(roleSelect().selectedOptions[0]?.textContent).toBe("Timer");
		await user.selectOptions(roleSelect(), "General");
		await user.type(screen.getByLabelText("What went well"), "Kind");
		await user.click(screen.getByRole("button", { name: "Send anonymously" }));
		await waitFor(() =>
			expect(leaveFeedback).toHaveBeenCalledWith({
				data: {
					meetingId: MEETING_ID,
					recipientMemberId: PAT,
					role: { kind: "general" },
					wentWell: "Kind",
					tryNext: "",
				},
			}),
		);
	});

	it("ignores Sent keys the old page wrote", async () => {
		sessionStorage.setItem(
			`gavelup:feedback-sent:${MEETING_ID}`,
			JSON.stringify([`slot:${SLOT_ID}`, `tableTopics:${TT_ID}`]),
		);
		await renderPage("open");
		await screen.findByRole("button", { name: /Pat Lee/ });
		expect(screen.queryByRole("button", { name: /Sent/ })).toBeNull();
	});
});

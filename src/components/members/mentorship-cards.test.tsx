// @vitest-environment jsdom
/**
 * The mentorship cards (#939), driven the way a member and an admin drive
 * them: what each renders from a payload, and which callbacks its controls
 * fire. Who may read or write is the server's (`mentorship-authz.guard.test.ts`,
 * `mentorship.integration.test.ts`).
 */
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClubPendingMentorRequest } from "#/server/mentorship";
import {
	ClubMentoringCard,
	type ClubMentoringView,
	INACTIVE_PARTY_NOTE,
	MEMBER_MENTORING_HEADING,
	MENTOR_CONFIRM_LABEL,
	MENTOR_SAVE_AND_LIST_LABEL,
	MENTOR_UNLISTED_NOTICE,
	MENTORING_HEADING,
	type MemberMentorshipsView,
	MentorshipAdminPanel,
	MentorshipCard,
	type MentorshipPartyRow,
	type MyMentorshipsView,
	WILLING_TO_MENTOR_LABEL,
	YOUR_MENTEES_HEADING,
	YOUR_MENTORS_HEADING,
} from "./mentorship-cards";

afterEach(cleanup);

async function renderInRouter(node: ReactNode) {
	const rootRoute = createRootRoute({
		component: () => (
			<>
				<span data-testid="mounted" />
				{node}
			</>
		),
	});
	rootRoute.addChildren([
		createRoute({
			getParentRoute: () => rootRoute,
			path: "/members/$id",
			component: () => null,
		}),
	]);
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
	const out = render(<RouterProvider router={router} />);
	await router.load();
	await screen.findByTestId("mounted");
	return out;
}

const party = (
	over: Partial<MentorshipPartyRow> & { name?: string } = {},
): MentorshipPartyRow => ({
	id: over.id ?? `p-${over.name ?? "x"}`,
	focus: over.focus ?? "new_member",
	focusOther: over.focusOther ?? null,
	startedAt: new Date("2026-09-01T00:00:00Z"),
	member: over.member ?? {
		id: `m-${over.name ?? "x"}`,
		name: over.name ?? "Maya Mentor",
		email: "maya@example.test",
		phone: "+15555550100",
		preferredContact: null,
	},
});

describe("MentorshipCard, the member's own (#939)", () => {
	it("renders nothing without a payload", async () => {
		const { container } = await renderInRouter(
			<MentorshipCard
				view={null}
				onToggleWilling={vi.fn()}
				onSaveBio={vi.fn()}
			/>,
		);
		expect(container.querySelector("section")).toBeNull();
	});

	it("shows mentors and mentees with name, focus and contact", async () => {
		const view: MyMentorshipsView = {
			mentorBio: null,
			mentorListed: true,
			willingToMentor: false,
			mentors: [party({ name: "Maya Mentor" })],
			mentees: [
				party({
					name: "Nia Newbie",
					focus: "other",
					focusOther: "Evaluations",
					member: {
						id: "m-nia",
						name: "Nia Newbie",
						email: null,
						phone: null,
						preferredContact: null,
					},
				}),
			],
		};
		const { container } = await renderInRouter(
			<MentorshipCard
				view={view}
				onToggleWilling={vi.fn()}
				onSaveBio={vi.fn()}
			/>,
		);
		expect(screen.getByText(MENTORING_HEADING)).toBeTruthy();
		expect(screen.getByText(YOUR_MENTORS_HEADING)).toBeTruthy();
		expect(screen.getByText(YOUR_MENTEES_HEADING)).toBeTruthy();
		const mentors = container.querySelector('[data-list="mentors"]');
		expect(mentors?.textContent).toContain("Maya Mentor");
		expect(mentors?.textContent).toContain("New member");
		const hrefs = [...(mentors?.querySelectorAll("a") ?? [])].map((a) =>
			a.getAttribute("href"),
		);
		expect(hrefs).toContain("mailto:maya@example.test");
		expect(hrefs.some((h) => h?.includes("15555550100"))).toBe(true);
		const mentees = container.querySelector('[data-list="mentees"]');
		expect(mentees?.textContent).toContain("Evaluations");
		expect(mentees?.textContent).toContain("No contact on file.");
	});

	it("omits a list with nothing in it", async () => {
		const { container } = await renderInRouter(
			<MentorshipCard
				view={{
					mentorBio: null,
					mentorListed: true,
					willingToMentor: false,
					mentors: [],
					mentees: [],
				}}
				onToggleWilling={vi.fn()}
				onSaveBio={vi.fn()}
			/>,
		);
		expect(container.querySelector('[data-list="mentors"]')).toBeNull();
		expect(container.querySelector('[data-list="mentees"]')).toBeNull();
		expect(screen.getByLabelText(WILLING_TO_MENTOR_LABEL)).toBeTruthy();
	});

	it("the willing checkbox reflects the flag and fires onToggleWilling", async () => {
		const user = userEvent.setup();
		const onToggleWilling = vi.fn(async () => undefined);
		await renderInRouter(
			<MentorshipCard
				view={{
					mentorBio: null,
					mentorListed: true,
					willingToMentor: false,
					mentors: [],
					mentees: [],
				}}
				onToggleWilling={onToggleWilling}
				onSaveBio={vi.fn()}
			/>,
		);
		const box = screen.getByLabelText(WILLING_TO_MENTOR_LABEL);
		expect((box as HTMLInputElement).checked).toBe(false);
		await user.click(box);
		expect(onToggleWilling).toHaveBeenCalledWith(true);
	});

	// protects=a member whose willing flag the import set (willing, not listed)
	// sees the "can't find you yet" line and a "Show me on Find a mentor" button
	// that fires onToggleWilling(true) (the confirm path), while a listed member
	// and a member who is not willing see neither;
	// fails_when=the notice shows for a listed or unwilling member, the button is
	// missing, or it fires something other than the willing=true confirmation;
	// no_claim=that the server lists them (mentor-listing.integration.test.ts)
	it("offers to list a willing member Find a mentor cannot show yet", async () => {
		const user = userEvent.setup();
		const onToggleWilling = vi.fn(async () => undefined);
		const base = {
			mentorBio: null,
			mentors: [],
			mentees: [],
		};
		await renderInRouter(
			<MentorshipCard
				view={{ ...base, willingToMentor: true, mentorListed: false }}
				onToggleWilling={onToggleWilling}
				onSaveBio={vi.fn()}
			/>,
		);
		expect(screen.getByText(MENTOR_UNLISTED_NOTICE)).toBeTruthy();
		await user.click(
			screen.getByRole("button", { name: MENTOR_CONFIRM_LABEL }),
		);
		expect(onToggleWilling).toHaveBeenCalledTimes(1);
		expect(onToggleWilling).toHaveBeenCalledWith(true);
		cleanup();
		for (const view of [
			{ ...base, willingToMentor: true, mentorListed: true },
			{ ...base, willingToMentor: false, mentorListed: false },
		]) {
			await renderInRouter(
				<MentorshipCard
					view={view}
					onToggleWilling={vi.fn()}
					onSaveBio={vi.fn()}
				/>,
			);
			expect(screen.queryByText(MENTOR_UNLISTED_NOTICE)).toBeNull();
			expect(
				screen.queryByRole("button", { name: MENTOR_CONFIRM_LABEL }),
			).toBeNull();
			cleanup();
		}
	});

	// protects=the bio editor of a willing member who is not listed yet says that
	// saving lists them ("Save and show me on Find a mentor"), because
	// setMyMentorBio publishes a willing member; a listed member's button stays
	// "Save"; the label click still sends the bio;
	// fails_when=an unlisted member's Save is a plain "Save" (a silent publish),
	// or a listed member's button claims to list them;
	// no_claim=that the server lists them on save (mentor-bio.integration.test.ts)
	it("labels the bio Save as listing the member while they are unlisted", async () => {
		const user = userEvent.setup();
		const onSaveBio = vi.fn(async () => undefined);
		const base = { mentorBio: null, mentors: [], mentees: [] };
		await renderInRouter(
			<MentorshipCard
				view={{ ...base, willingToMentor: true, mentorListed: false }}
				onToggleWilling={vi.fn()}
				onSaveBio={onSaveBio}
			/>,
		);
		expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
		await user.type(screen.getByRole("textbox"), "Contests");
		await user.click(
			screen.getByRole("button", { name: MENTOR_SAVE_AND_LIST_LABEL }),
		);
		expect(onSaveBio).toHaveBeenCalledWith("Contests");
		cleanup();

		await renderInRouter(
			<MentorshipCard
				view={{ ...base, willingToMentor: true, mentorListed: true }}
				onToggleWilling={vi.fn()}
				onSaveBio={vi.fn()}
			/>,
		);
		expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: MENTOR_SAVE_AND_LIST_LABEL }),
		).toBeNull();
	});

	it("never reads as the charter club mentor", async () => {
		const { container } = await renderInRouter(
			<MentorshipCard
				view={{
					mentorBio: null,
					mentorListed: true,
					willingToMentor: true,
					mentors: [party()],
					mentees: [party({ name: "Nia" })],
				}}
				onToggleWilling={vi.fn()}
				onSaveBio={vi.fn()}
			/>,
		);
		expect(container.textContent?.toLowerCase()).not.toContain("club mentor");
	});
});

describe("ClubMentoringCard, the admin's list (#939)", () => {
	const view: ClubMentoringView = {
		active: [
			{
				id: "p1",
				focus: "contest",
				focusOther: null,
				startedAt: new Date("2026-09-01T00:00:00Z"),
				mentor: { id: "m1", name: "Maya Mentor" },
				mentee: { id: "m2", name: "Nia Newbie" },
			},
		],
		unpaired: [
			{ id: "m3", name: "Veteran Vic", inOrientation: false },
			{ id: "m4", name: "Fresh Fay", inOrientation: true },
		],
		willing: [{ id: "m1", name: "Maya Mentor" }],
	};

	it("renders nothing without a payload (a member's dashboard)", async () => {
		const { container } = await renderInRouter(
			<ClubMentoringCard view={null} />,
		);
		expect(container.querySelector("section")).toBeNull();
	});

	it("lists active pairings, the unpaired (new members first) and the willing", async () => {
		const { container } = await renderInRouter(
			<ClubMentoringCard view={view} />,
		);
		expect(screen.getByText(MEMBER_MENTORING_HEADING)).toBeTruthy();
		const active = container.querySelector('[data-list="active-pairings"]');
		expect(active?.textContent).toContain("Nia Newbie");
		expect(active?.textContent).toContain("mentored by");
		expect(active?.textContent).toContain("Contest");
		const unpaired = [
			...(container.querySelectorAll('[data-list="unpaired"] li') ?? []),
		].map((li) => li.textContent);
		expect(unpaired[0]).toContain("Fresh Fay");
		expect(unpaired[1]).toContain("Veteran Vic");
		expect(
			container.querySelector('[data-list="willing"]')?.textContent,
		).toContain("Maya Mentor");
		expect(container.textContent?.toLowerCase()).not.toContain("club mentor");
	});
});

describe("MentorshipAdminPanel, the member page (#939)", () => {
	const view: MemberMentorshipsView = {
		willingToMentor: false,
		mentors: [party({ id: "pair-1", name: "Maya Mentor" })],
		mentees: [],
		candidates: [
			{ id: "c-willing", name: "Will Ing", willingToMentor: true },
			{ id: "c-other", name: "Abe Other", willingToMentor: false },
		],
	};

	function renderPanel(
		over: Partial<Parameters<typeof MentorshipAdminPanel>[0]> = {},
	) {
		const props = {
			memberName: "Nia",
			memberActive: true,
			view,
			onAdd: vi.fn(async () => undefined),
			onEnd: vi.fn(async () => undefined),
			onFocus: vi.fn(async () => undefined),
			...over,
		};
		return renderInRouter(<MentorshipAdminPanel {...props} />).then((out) => ({
			...out,
			props,
		}));
	}

	it("offers willing members first, marked", async () => {
		await renderPanel();
		const select = screen.getByLabelText("Add a mentor") as HTMLSelectElement;
		const options = [...select.options].map((o) => o.textContent);
		expect(options).toEqual([
			"Choose a member…",
			"Will Ing (willing)",
			"Abe Other",
		]);
	});

	it("pairs the chosen mentor with the chosen focus", async () => {
		const user = userEvent.setup();
		const { props } = await renderPanel();
		const add = screen.getByRole("button", { name: /Pair with mentor/ });
		expect((add as HTMLButtonElement).disabled).toBe(true);
		await user.selectOptions(screen.getByLabelText("Add a mentor"), "c-other");
		await user.selectOptions(screen.getByLabelText("Focus"), "other");
		await user.type(screen.getByLabelText("Describe the focus"), "Contests");
		await user.click(add);
		expect(props.onAdd).toHaveBeenCalledWith({
			mentorMemberId: "c-other",
			focus: "other",
			focusOther: "Contests",
		});
	});

	it("defaults the focus to new member", async () => {
		const user = userEvent.setup();
		const { props } = await renderPanel();
		await user.selectOptions(
			screen.getByLabelText("Add a mentor"),
			"c-willing",
		);
		await user.click(screen.getByRole("button", { name: /Pair with mentor/ }));
		expect(props.onAdd).toHaveBeenCalledWith({
			mentorMemberId: "c-willing",
			focus: "new_member",
			focusOther: null,
		});
	});

	it("End and a focus change fire with the pairing's id", async () => {
		const user = userEvent.setup();
		const { props } = await renderPanel();
		await user.click(screen.getByRole("button", { name: "End" }));
		expect(props.onEnd).toHaveBeenCalledWith("pair-1");
		await user.selectOptions(
			screen.getByLabelText("Focus for Maya Mentor"),
			"leadership",
		);
		expect(props.onFocus).toHaveBeenCalledWith("pair-1", "leadership", null);
	});

	it("offers no pairing for an inactive member", async () => {
		await renderPanel({ memberActive: false });
		expect(screen.queryByLabelText("Add a mentor")).toBeNull();
		expect(screen.getByText(/Reactivate Nia/)).toBeTruthy();
	});
});

describe("MentorshipCard welcome draft window (#1209)", () => {
	const NOW = new Date("2026-10-15T12:00:00Z").getTime();
	const DAY = 24 * 60 * 60 * 1000;
	const mentee = (name: string, startedAt: number) => ({
		...party({
			name,
			member: {
				id: `m-${name}`,
				name,
				email: `${name}@example.test`,
				phone: null,
				preferredContact: null,
			},
		}),
		id: `p-${name}`,
		startedAt: new Date(startedAt),
	});

	// protects=a mentee paired exactly 14 days ago still gets the mentor's
	// say-hi draft, one millisecond later does not, and a brand-new one does;
	// fails_when=the window is 13 days, off by a comparison (`<` for `<=`), or
	// is judged against the wall clock instead of the `now` the loader pinned;
	// no_claim=what the draft says (nudge.test.ts)
	it("offers the draft through day 14 and not after", async () => {
		const view: MyMentorshipsView = {
			mentorBio: null,
			mentorListed: true,
			willingToMentor: true,
			mentors: [],
			mentees: [
				mentee("edge", NOW - 14 * DAY),
				mentee("late", NOW - 14 * DAY - 1),
				mentee("fresh", NOW - 1000),
			],
		};
		const { container } = await renderInRouter(
			<MentorshipCard
				view={view}
				now={NOW}
				onToggleWilling={vi.fn()}
				onSaveBio={vi.fn()}
			/>,
		);
		const has = (id: string) =>
			container
				.querySelector(`li[data-mentorship="${id}"]`)
				?.querySelector('[data-slot="mentor-welcome"]') !== null;
		expect(has("p-edge")).toBe(true);
		expect(has("p-late")).toBe(false);
		expect(has("p-fresh")).toBe(true);
	});
});

describe("ClubMentoringCard pending requests (#1209)", () => {
	const view: ClubMentoringView = { active: [], unpaired: [], willing: [] };
	const pending = (
		id: string,
		over: Partial<ClubPendingMentorRequest> = {},
	): ClubPendingMentorRequest => ({
		id,
		focus: "contest",
		focusOther: null,
		createdAt: new Date("2026-10-10T02:00:00Z"),
		mentor: { id: "m-mia", name: "Mia Mentor" },
		mentee: { id: `m-${id}`, name: "Sam Smith" },
		partyInactive: false,
		...over,
	});

	// protects=the admin's "Pending requests (n)" lists mentee asked mentor with
	// the focus and the date in the CLUB's zone, and nothing when no answer
	// handler is given;
	// fails_when=the heading count, a name, the focus or the zone's date is
	// wrong (02:00 UTC is still Oct 9 in Los Angeles), or a list with no handler
	// shows buttons that do nothing;
	// no_claim=which requests the server lists (the integration test)
	it("lists each request with its date in the club's timezone", async () => {
		const { container, rerender } = await renderInRouter(
			<ClubMentoringCard
				view={view}
				pendingRequests={[pending("r1"), pending("r2")]}
				onDecide={vi.fn()}
				timezone="America/Los_Angeles"
			/>,
		);
		expect(screen.getByText("Pending requests (2)")).toBeTruthy();
		const rows = container.querySelectorAll("li[data-request]");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toContain("Sam Smith asked Mia Mentor");
		expect(rows[0]?.textContent).toContain("Contest · Oct 9");
		rerender(
			<ClubMentoringCard view={view} pendingRequests={[pending("r1")]} />,
		);
		expect(screen.queryByText(/Pending requests/)).toBeNull();
	});

	// protects=Accept and Decline each call onDecide with the request's id and the
	// matching boolean (an admin answering for the mentor);
	// fails_when=the buttons are swapped, or name the wrong request;
	// no_claim=that the server authorizes the admin (guard test)
	it("Accept and Decline answer on the mentor's behalf", async () => {
		const user = userEvent.setup();
		const onDecide = vi.fn().mockResolvedValue(undefined);
		await renderInRouter(
			<ClubMentoringCard
				view={view}
				pendingRequests={[pending("r1"), pending("r2")]}
				onDecide={onDecide}
			/>,
		);
		const accepts = screen.getAllByRole("button", { name: "Accept" });
		const declines = screen.getAllByRole("button", { name: "Decline" });
		await user.click(accepts[1] as HTMLElement);
		expect(onDecide).toHaveBeenLastCalledWith("r2", true);
		await user.click(declines[0] as HTMLElement);
		expect(onDecide).toHaveBeenLastCalledWith("r1", false);
	});

	// protects=while an answer is in flight every button is disabled and the
	// answered row's Accept shows a spinner; it all comes back afterwards;
	// fails_when=a second answer can start mid-flight, or the buttons stay
	// disabled once it settles;
	// no_claim=the server's own race handling (integration test)
	it("disables the buttons while an answer is in flight", async () => {
		const user = userEvent.setup();
		let settle: () => void = () => {};
		const onDecide = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					settle = resolve;
				}),
		);
		const { container } = await renderInRouter(
			<ClubMentoringCard
				view={view}
				pendingRequests={[pending("r1"), pending("r2")]}
				onDecide={onDecide}
			/>,
		);
		await user.click(
			screen.getAllByRole("button", { name: "Accept" })[0] as HTMLElement,
		);
		for (const b of container.querySelectorAll("li[data-request] button")) {
			expect((b as HTMLButtonElement).disabled).toBe(true);
		}
		expect(
			container.querySelector('li[data-request="r1"] svg.animate-spin'),
		).not.toBeNull();
		expect(
			container.querySelector('li[data-request="r2"] svg.animate-spin'),
		).toBeNull();
		settle();
		await waitFor(() => {
			for (const b of container.querySelectorAll("li[data-request] button")) {
				expect((b as HTMLButtonElement).disabled).toBe(false);
			}
		});
	});

	// protects=a refused answer shows the server's message in an alert (or the
	// generic fallback for a blank one) and the row keeps its buttons;
	// fails_when=the error is swallowed or the row's buttons go away;
	// no_claim=the wording of the server's refusals
	it("shows a refusal in an alert and keeps the row", async () => {
		const user = userEvent.setup();
		const onDecide = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("That request has already been answered."),
			)
			.mockRejectedValueOnce(new Error(""));
		await renderInRouter(
			<ClubMentoringCard
				view={view}
				pendingRequests={[pending("r1")]}
				onDecide={onDecide}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Accept" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"That request has already been answered.",
		);
		await user.click(screen.getByRole("button", { name: "Decline" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"Something went wrong. Try again.",
			),
		);
		expect(screen.getByRole("button", { name: "Accept" })).toBeTruthy();
	});

	// protects=a request with an inactive party offers Decline only, with the
	// note why, so the admin can clear it; an all-active one offers both;
	// fails_when=Accept is offered for a request the server refuses, or Decline
	// is missing and the mentee's one slot cannot be freed;
	// no_claim=that the reader flags the right requests (the integration test)
	it("offers only Decline for a request with an inactive party", async () => {
		const user = userEvent.setup();
		const onDecide = vi.fn().mockResolvedValue(undefined);
		const { container } = await renderInRouter(
			<ClubMentoringCard
				view={view}
				pendingRequests={[
					pending("r1", { partyInactive: true }),
					pending("r2"),
				]}
				onDecide={onDecide}
			/>,
		);
		const r1 = container.querySelector('li[data-request="r1"]') as HTMLElement;
		const r2 = container.querySelector('li[data-request="r2"]') as HTMLElement;
		expect(r1.textContent).toContain(INACTIVE_PARTY_NOTE);
		expect(r1.textContent).not.toContain("Accept");
		expect(r2.textContent).toContain("Accept");
		expect(r2.textContent).not.toContain(INACTIVE_PARTY_NOTE);
		await user.click(
			[...r1.querySelectorAll("button")].find(
				(b) => b.textContent === "Decline",
			) as HTMLElement,
		);
		expect(onDecide).toHaveBeenCalledWith("r1", false);
	});
});

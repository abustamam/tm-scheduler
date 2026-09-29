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
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ClubMentoringCard,
	type ClubMentoringView,
	MEMBER_MENTORING_HEADING,
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
	},
});

describe("MentorshipCard, the member's own (#939)", () => {
	it("renders nothing without a payload", async () => {
		const { container } = await renderInRouter(
			<MentorshipCard view={null} onToggleWilling={vi.fn()} />,
		);
		expect(container.querySelector("section")).toBeNull();
	});

	it("shows mentors and mentees with name, focus and contact", async () => {
		const view: MyMentorshipsView = {
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
					},
				}),
			],
		};
		const { container } = await renderInRouter(
			<MentorshipCard view={view} onToggleWilling={vi.fn()} />,
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
				view={{ willingToMentor: false, mentors: [], mentees: [] }}
				onToggleWilling={vi.fn()}
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
				view={{ willingToMentor: false, mentors: [], mentees: [] }}
				onToggleWilling={onToggleWilling}
			/>,
		);
		const box = screen.getByLabelText(WILLING_TO_MENTOR_LABEL);
		expect((box as HTMLInputElement).checked).toBe(false);
		await user.click(box);
		expect(onToggleWilling).toHaveBeenCalledWith(true);
	});

	it("never reads as the charter club mentor", async () => {
		const { container } = await renderInRouter(
			<MentorshipCard
				view={{
					willingToMentor: true,
					mentors: [party()],
					mentees: [party({ name: "Nia" })],
				}}
				onToggleWilling={vi.fn()}
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

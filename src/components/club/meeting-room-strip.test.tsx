// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Both reach `#/db` through their logic modules; the real build strips that.
vi.mock("#/server/voting", () => ({ getBallot: vi.fn() }));
vi.mock("#/server/members", () => ({ listMembers: vi.fn() }));

import {
	IdentityGateProvider,
	useRequireIdentity,
} from "#/components/club/identity-gate";
import type { StoredMember } from "#/lib/member-identity";
import { listMembers } from "#/server/members";
import { getBallot } from "#/server/voting";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingRoomStrip, ROOM_VOTE_POLL_MS } from "./meeting-room-strip";

const CLUB = "downtown";
const CLUB_UUID = "11111111-2222-4333-8444-555555555555";
const MEETING_UUID = "99999999-2222-4333-8444-555555555555";
const KEY = "2026-09-25";
const PAT: StoredMember = { id: "m-pat", name: "Pat Lee" };

type Ballot = Awaited<ReturnType<typeof getBallot>>;
function ballot(open: boolean): Ballot {
	const cat = (isOpen: boolean) => ({
		isOpen,
		hasOpened: isOpen,
		candidates: [],
	});
	return {
		meetingId: MEETING_UUID,
		categories: {
			best_speaker: cat(open),
			best_evaluator: cat(false),
			best_table_topics: cat(false),
		},
		digitalVotingOff: false,
	} as Ballot;
}

interface HarnessProps {
	visible: boolean;
	assigneeIds: string[];
	wordOfTheDay: string | null;
}
const DEFAULTS: HarnessProps = {
	visible: true,
	assigneeIds: [],
	wordOfTheDay: null,
};

/** Set from inside the harness so a test can change props mid-visit. */
let setHarness: (p: Partial<HarnessProps>) => void = () => {};

/**
 * Wires the strip exactly as the route does: identity from the page's
 * `IdentityGateProvider`, `holdsRole` from whether that identity is among the
 * slot assignees. That is what lets "pick a name" be tested end to end — the
 * pick goes through the real picker into the shared member store.
 */
function Wired({ initial }: { initial: HarnessProps }) {
	const [props, setProps] = useState(initial);
	setHarness = (p) => setProps((prev) => ({ ...prev, ...p }));
	const { member, promptIdentity } = useRequireIdentity();
	return (
		<MeetingRoomStrip
			visible={props.visible}
			clubId={CLUB}
			meetingKey={KEY}
			dbMeetingId={MEETING_UUID}
			member={member}
			holdsRole={member !== null && props.assigneeIds.includes(member.id)}
			wordOfTheDay={props.wordOfTheDay}
			promptIdentity={promptIdentity}
		/>
	);
}

async function renderStrip(
	overrides: Partial<HarnessProps> = {},
	sessionMember: StoredMember | null = null,
) {
	const client = new QueryClient();
	await renderUnderMemoryRouter(
		<QueryClientProvider client={client}>
			<IdentityGateProvider
				clubUuid={CLUB_UUID}
				clubSlug={CLUB}
				sessionMember={sessionMember}
			>
				<Wired initial={{ ...DEFAULTS, ...overrides }} />
			</IdentityGateProvider>
		</QueryClientProvider>,
	);
}

/** The strip's buttons, in rendered order, by their visible label. */
function labels(): string[] {
	const strip = screen.getByTestId("meeting-room-strip");
	return [...strip.querySelectorAll("a")].map(
		(a) => a.textContent?.trim() ?? "",
	);
}
const href = (name: string) =>
	screen.getByRole("link", { name }).getAttribute("href");

beforeEach(() => {
	localStorage.clear();
	vi.mocked(getBallot).mockReset();
	vi.mocked(getBallot).mockResolvedValue(ballot(false));
	vi.mocked(listMembers).mockResolvedValue([
		{ id: PAT.id, name: PAT.name, officerPositions: [] },
	] as unknown as Awaited<ReturnType<typeof listMembers>>);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("MeetingRoomStrip — visibility (#913 AC1)", () => {
	it("renders nothing, and does not poll, when not visible", async () => {
		await renderStrip({ visible: false });
		expect(screen.queryByTestId("meeting-room-strip")).toBeNull();
		expect(getBallot).not.toHaveBeenCalled();
	});

	/**
	 * Voting OFF when the page loaded, then an officer switches it back on and
	 * opens a category. The strip takes no voting prop at all — the page's value
	 * is frozen at load — so it keeps polling, reads the server's closed answer
	 * while voting is off (`loadBallot` returns every category closed then), and
	 * shows Vote as soon as the ballot reports one open, with no reload.
	 */
	it("shows Vote after voting is switched back on mid-visit, without a reload", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.mocked(getBallot).mockResolvedValue({
			...ballot(false),
			digitalVotingOff: true,
		});
		await renderStrip();
		await waitFor(() => expect(getBallot).toHaveBeenCalledTimes(1));
		expect(labels()).not.toContain("Vote");

		vi.mocked(getBallot).mockResolvedValue(ballot(true));
		await act(() => vi.advanceTimersByTimeAsync(ROOM_VOTE_POLL_MS));
		await waitFor(() => expect(labels()[0]).toBe("Vote"));
	});
});

describe("MeetingRoomStrip — identity branching (#913 AC2, AC3)", () => {
	it("identified, holding a role: Vote · What I'm doing today · Word of the Day · Today's agenda", async () => {
		vi.mocked(getBallot).mockResolvedValue(ballot(true));
		await renderStrip(
			{ assigneeIds: [PAT.id], wordOfTheDay: "Serendipity" },
			PAT,
		);
		await waitFor(() => expect(labels()[0]).toBe("Vote"));
		expect(labels()).toEqual([
			"Vote",
			"What I'm doing today",
			"Word of the Day",
			"Today's agenda",
		]);
		expect(href("Vote")).toBe(`/club/${CLUB}/meeting/${KEY}/vote`);
		expect(href("What I'm doing today")).toBe(
			`/club/${CLUB}/meeting/${KEY}/me`,
		);
		expect(href("Word of the Day")).toBe(`/club/${CLUB}/meeting/${KEY}/word`);
		expect(href("Today's agenda")).toMatch(/#agenda$/);
		expect(
			screen.queryByRole("button", { name: /pick your name/i }),
		).toBeNull();
		expect(screen.queryByRole("link", { name: /guest book/i })).toBeNull();
	});

	it("identified with no role: no 'What I'm doing today', and no guest book either", async () => {
		await renderStrip({ assigneeIds: ["someone-else"] }, PAT);
		expect(labels()).toEqual(["Today's agenda"]);
	});

	it("no identity: Vote · Sign the guest book · Word of the Day · Today's agenda, plus Pick your name", async () => {
		vi.mocked(getBallot).mockResolvedValue(ballot(true));
		await renderStrip({ assigneeIds: [PAT.id], wordOfTheDay: "Serendipity" });
		await waitFor(() => expect(labels()[0]).toBe("Vote"));
		expect(labels()).toEqual([
			"Vote",
			"Sign the guest book",
			"Word of the Day",
			"Today's agenda",
		]);
		expect(href("Sign the guest book")).toBe(`/club/${CLUB}/guest-book`);
		expect(
			screen.getByRole("button", { name: "Member? Pick your name" }),
		).toBeTruthy();
	});

	it("no Word of the Day button when the word is unset or blank", async () => {
		await renderStrip({ wordOfTheDay: "   " });
		expect(labels()).toEqual(["Sign the guest book", "Today's agenda"]);
	});

	it("picking a name switches to the identified column without a reload", async () => {
		const user = userEvent.setup();
		await renderStrip({ assigneeIds: [PAT.id] });
		expect(labels()).toContain("Sign the guest book");

		await user.click(
			screen.getByRole("button", { name: "Member? Pick your name" }),
		);
		await user.click(await screen.findByRole("button", { name: /Pat Lee/ }));

		await waitFor(() =>
			expect(labels()).toEqual(["What I'm doing today", "Today's agenda"]),
		);
		expect(
			screen.queryByRole("button", { name: /pick your name/i }),
		).toBeNull();
	});
});

describe("MeetingRoomStrip — the vote poll (#913 AC4)", () => {
	it("shows no Vote while nothing is open, then Vote FIRST once the poll reports one open", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		await renderStrip({ wordOfTheDay: "Serendipity" });
		await waitFor(() => expect(getBallot).toHaveBeenCalledTimes(1));
		expect(labels()).not.toContain("Vote");

		vi.mocked(getBallot).mockResolvedValue(ballot(true));
		await act(() => vi.advanceTimersByTimeAsync(ROOM_VOTE_POLL_MS));

		await waitFor(() => expect(labels()[0]).toBe("Vote"));
		expect(getBallot).toHaveBeenLastCalledWith({
			data: { meetingId: MEETING_UUID },
		});
	});

	it("hides Vote on a failed poll after an 'open' answer, and brings it back on the next success", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.mocked(getBallot).mockResolvedValue(ballot(true));
		await renderStrip();
		await waitFor(() => expect(labels()[0]).toBe("Vote"));

		vi.mocked(getBallot).mockRejectedValue(new Error("offline"));
		await act(() => vi.advanceTimersByTimeAsync(ROOM_VOTE_POLL_MS));
		await waitFor(() => expect(labels()).not.toContain("Vote"));
		// `retry: false`: one failed poll is one call, not three.
		const callsAfterError = vi.mocked(getBallot).mock.calls.length;

		vi.mocked(getBallot).mockResolvedValue(ballot(true));
		await act(() => vi.advanceTimersByTimeAsync(ROOM_VOTE_POLL_MS));
		await waitFor(() => expect(labels()[0]).toBe("Vote"));
		expect(vi.mocked(getBallot).mock.calls.length).toBe(callsAfterError + 1);
	});

	it("stops polling once the strip is hidden", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		await renderStrip();
		await waitFor(() => expect(getBallot).toHaveBeenCalledTimes(1));
		await act(() => vi.advanceTimersByTimeAsync(ROOM_VOTE_POLL_MS));
		await waitFor(() => expect(getBallot).toHaveBeenCalledTimes(2));

		act(() => setHarness({ visible: false }));
		expect(screen.queryByTestId("meeting-room-strip")).toBeNull();
		await act(() => vi.advanceTimersByTimeAsync(ROOM_VOTE_POLL_MS * 3));
		expect(getBallot).toHaveBeenCalledTimes(2);
	});
});

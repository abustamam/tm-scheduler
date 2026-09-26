// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Slide } from "#/lib/agenda-slides";
import type { NextMeetingSummary } from "#/lib/next-meeting-summary";
import { MeetingPresent } from "./meeting-present";
import {
	NEXT_MEETING_REFRESH_MS,
	useNextMeetingRefresh,
} from "./use-next-meeting-refresh";

const { getVoteParticipation } = vi.hoisted(() => ({
	getVoteParticipation: vi.fn(),
}));
vi.mock("#/server/voting", () => ({ getVoteParticipation }));

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

const SIGNUP = "https://gavelup.test/club/mcf/meeting/2026-07-09";

const onTap = (signupUrl: string | null): Slide => ({
	kind: "nextMeeting",
	scheduledAt: new Date("2026-07-09T23:45:00Z"),
	timezone: "America/Chicago",
	location: "Library Room B",
	theme: "Momentum",
	meetingNumber: 57,
	toastmaster: { label: "Toastmaster of the Day", names: [], openCount: 1 },
	roles: [
		{ label: "Timer", names: [], openCount: 1 },
		{ label: "Grammarian", names: ["Mona"], openCount: 0 },
	],
	signupUrl,
});

const deckWith = (signupUrl: string | null): Slide[] => [
	{
		kind: "title",
		clubName: "MCF",
		logoUrl: null,
		district: null,
		clubNumber: null,
		meetingNumber: null,
		scheduledAt: new Date("2026-06-25T23:45:00Z"),
		timezone: "America/Chicago",
	},
	onTap(signupUrl),
	{
		kind: "thankYou",
		meetingSchedule: null,
		nextMeetingAt: new Date("2026-07-09T23:45:00Z"),
		timezone: "America/Chicago",
	},
];

function present(deck: Slide[]) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<MeetingPresent deck={deck} clubName="MCF" meetingId="m1" />
		</QueryClientProvider>,
	);
	// To the next-meeting slide.
	fireEvent.keyDown(window, { key: "ArrowRight" });
}

describe("the next-meeting slide on the projector (#932)", () => {
	it("shows the header, the line-up and the open marker", () => {
		present(deckWith(SIGNUP));
		expect(screen.getByText("What’s on tap for next meeting")).toBeTruthy();
		expect(
			screen.getByText("Thursday, July 9, 2026 · 6:45 PM · Library Room B"),
		).toBeTruthy();
		expect(screen.getByTestId("next-meeting-toastmaster").textContent).toBe(
			"Toastmaster of the Day: Open: grab it!",
		);
		const roles = screen
			.getAllByTestId("next-meeting-role")
			.map((r) => r.textContent);
		expect(roles).toEqual(["Timer: Open: grab it!", "Grammarian: Mona"]);
		expect(screen.getByText("Meeting #57 · Theme: “Momentum”")).toBeTruthy();
	});

	it("shows a scannable QR with its caption once the URL is known", () => {
		present(deckWith(SIGNUP));
		const plate = screen.getByTestId("next-meeting-qr");
		expect(plate.querySelector("svg")).toBeTruthy();
		expect(screen.getByText("Scan to grab a role")).toBeTruthy();
	});

	it("shows no QR before the origin is known, and every role still", () => {
		present(deckWith(null));
		expect(screen.queryByTestId("next-meeting-qr")).toBeNull();
		expect(screen.queryByText("Scan to grab a role")).toBeNull();
		expect(screen.getAllByTestId("next-meeting-role")).toHaveLength(2);
	});
});

const SNAPSHOT: NextMeetingSummary = {
	scheduledAt: new Date("2026-07-09T23:45:00Z"),
	location: "Library Room B",
	theme: null,
	meetingNumber: null,
	urlKey: "2026-07-09",
	toastmaster: null,
	roles: [{ label: "Timer", names: [], openCount: 1 }],
};
const FRESH: NextMeetingSummary = {
	...SNAPSHOT,
	roles: [{ label: "Timer", names: ["Ana"], openCount: 0 }],
};

function hook(
	snapshot: NextMeetingSummary | null,
	fetcher: () => Promise<NextMeetingSummary | null>,
	qc = new QueryClient(),
) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	const view = renderHook(
		() => useNextMeetingRefresh(snapshot, ["club", "m1"], fetcher),
		{ wrapper },
	);
	return { qc, view };
}

describe("the silent refresh behind the slide (#932)", () => {
	it("renders the snapshot at once, without fetching", () => {
		const fetcher = vi.fn();
		const { view } = hook(SNAPSHOT, fetcher);
		expect(view.result.current).toEqual(SNAPSHOT);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("a failed refresh (network off) keeps the snapshot, with no error state", async () => {
		const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
		const { qc, view } = hook(SNAPSHOT, fetcher);
		await act(() => qc.refetchQueries());
		expect(fetcher).toHaveBeenCalledTimes(1);
		// The whole snapshot, not a blank or a partial one.
		expect(view.result.current).toEqual(SNAPSHOT);
	});

	it("a successful refresh replaces it, and a later failure keeps the fresh copy", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(FRESH)
			.mockRejectedValueOnce(new TypeError("Failed to fetch"));
		const { qc, view } = hook(SNAPSHOT, fetcher);
		await act(() => qc.refetchQueries());
		await waitFor(() => expect(view.result.current).toEqual(FRESH));
		await act(() => qc.refetchQueries());
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(view.result.current).toEqual(FRESH);
	});

	it("a refresh answering 'no next meeting' keeps the LAST GOOD copy, not the load-time one", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(FRESH)
			.mockResolvedValueOnce(null);
		const { qc, view } = hook(SNAPSHOT, fetcher);
		await act(() => qc.refetchQueries());
		await waitFor(() => expect(view.result.current).toEqual(FRESH));
		await act(() => qc.refetchQueries());
		await waitFor(() =>
			expect(
				qc.getQueryData(["next-meeting-summary", "club", "m1"]),
			).toBeNull(),
		);
		view.rerender();
		expect(view.result.current).toEqual(FRESH);
	});

	it("a refresh answering 'no next meeting' keeps the slide", async () => {
		const fetcher = vi.fn().mockResolvedValue(null);
		const { qc, view } = hook(SNAPSHOT, fetcher);
		await act(() => qc.refetchQueries());
		expect(fetcher).toHaveBeenCalled();
		// The refresh really did land as "none" in the cache…
		await waitFor(() =>
			expect(
				qc.getQueryData(["next-meeting-summary", "club", "m1"]),
			).toBeNull(),
		);
		view.rerender();
		// …and the slide keeps the snapshot anyway.
		expect(view.result.current).toEqual(SNAPSHOT);
	});

	it("never polls a deck loaded with no next meeting", async () => {
		const fetcher = vi.fn().mockResolvedValue(FRESH);
		const { qc, view } = hook(null, fetcher);
		await act(() => qc.refetchQueries());
		expect(fetcher).not.toHaveBeenCalled();
		expect(view.result.current).toBeNull();
	});

	// A reopened deck is a new presentation: the loader's snapshot is the
	// truth, not whatever the previous session left in the query cache —
	// React Query ignores `initialData` whenever the key is already cached.
	it("a reopened deck with no next meeting shows none, not the last session's", async () => {
		const qc = new QueryClient();
		const first = hook(SNAPSHOT, vi.fn().mockResolvedValue(FRESH), qc);
		await act(() => qc.refetchQueries());
		await waitFor(() => expect(first.view.result.current).toEqual(FRESH));
		first.view.unmount();
		// The next meeting was cancelled in between. The wait lets React Query's
		// eviction timer fire, as leaving and reopening the deck does.
		await act(() => new Promise((r) => setTimeout(r, 10)));
		const { view } = hook(null, vi.fn(), qc);
		expect(view.result.current).toBeNull();
	});

	it("a reopened deck starts from its own snapshot, not the last session's", async () => {
		const qc = new QueryClient();
		const first = hook(FRESH, vi.fn(), qc);
		expect(first.view.result.current).toEqual(FRESH);
		first.view.unmount();
		await act(() => new Promise((r) => setTimeout(r, 10)));
		const { view } = hook(SNAPSHOT, vi.fn(), qc);
		expect(view.result.current).toEqual(SNAPSHOT);
	});

	it("switching to another meeting's deck without unmounting drops the last deck's next meeting", async () => {
		const qc = new QueryClient();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		);
		const view = renderHook(
			({ snapshot, meetingId }) =>
				useNextMeetingRefresh(
					snapshot,
					["club", meetingId],
					vi.fn().mockResolvedValue(FRESH),
				),
			{
				wrapper,
				initialProps: {
					snapshot: SNAPSHOT as NextMeetingSummary | null,
					meetingId: "m1",
				},
			},
		);
		await act(() => qc.refetchQueries());
		await waitFor(() => expect(view.result.current).toEqual(FRESH));
		view.rerender({ snapshot: null, meetingId: "m2" });
		expect(view.result.current).toBeNull();
	});

	it("refreshes on its own cadence", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const fetcher = vi.fn().mockResolvedValue(FRESH);
		const { view } = hook(SNAPSHOT, fetcher);
		expect(fetcher).not.toHaveBeenCalled();
		await act(() => vi.advanceTimersByTimeAsync(NEXT_MEETING_REFRESH_MS + 10));
		await waitFor(() => expect(view.result.current).toEqual(FRESH));
	});
});

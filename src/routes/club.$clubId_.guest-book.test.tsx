// @vitest-environment jsdom
//
// The public guest-book form's error state (#1137).
//
// `captureGuestVisit` refuses a visit recorded against a meeting the `record`
// write class refuses (a cancelled one, cancelled while the visit queued), and
// `meeting-write-policy-record.integration.test.ts` pins that it throws
// `MEETING_CANCELLED_MESSAGE` and writes nothing. This is the other half: that a
// person at the form READS that sentence, in the error state, and is not shown
// the welcome that says their visit was recorded.
//
// The route is the first thing a visitor sees and there is no session behind it,
// so there is no one to explain a generic failure. The form renders the thrown
// message as it arrived; this pins that it does so for this sentence and keeps
// the form open to retry.
//
// Same pattern as `club.$clubId_.meeting.$meetingId.word.test.tsx`: mock the
// route's server-fn and club-resolver imports (both reach `#/db` → `pg`), spy
// `Route.useLoaderData`, mount under a memory router.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEETING_CANCELLED_MESSAGE } from "#/lib/meeting-cancellation-notice";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/guest-pipeline", () => ({ submitGuestBook: vi.fn() }));
vi.mock("#/lib/club-route", () => ({ resolveClubOrRedirect: vi.fn() }));

import { submitGuestBook } from "#/server/guest-pipeline";
import { Route } from "./club.$clubId_.guest-book";

const CLUB_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		clubId: CLUB_ID,
		clubName: "Downtown Toastmasters",
		clubNumber: "1234",
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

async function openForm() {
	const Component = Route.options.component as () => React.ReactElement;
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	await renderUnderMemoryRouter(
		<QueryClientProvider client={client}>
			<Component />
		</QueryClientProvider>,
	);
}

async function signAs(name: string) {
	const user = userEvent.setup();
	await user.type(await screen.findByLabelText("Your name"), name);
	await user.click(screen.getByRole("button", { name: "Sign the guest book" }));
}

describe("the guest-book form (#1137)", () => {
	it("the control: a recorded visit shows the welcome", async () => {
		vi.mocked(submitGuestBook).mockResolvedValue({ ok: true, created: true });
		await openForm();
		await signAs("Jamie Rivera");
		expect(await screen.findByText("Welcome, Jamie!")).toBeTruthy();
	});

	it("a visit refused for a cancelled meeting shows the sentence, keeps the form, and shows no welcome", async () => {
		vi.mocked(submitGuestBook).mockRejectedValue(
			new Error(MEETING_CANCELLED_MESSAGE),
		);
		await openForm();
		await signAs("Jamie Rivera");

		expect(await screen.findByText(MEETING_CANCELLED_MESSAGE)).toBeTruthy();
		// The error state, not the success state: the submit button is still there
		// to retry, and nothing says the visit was recorded.
		expect(
			screen.getByRole("button", { name: "Sign the guest book" }),
		).toBeTruthy();
		expect(screen.queryByText(/Welcome, /)).toBeNull();
		expect(screen.queryByText(/Thanks for signing/)).toBeNull();
		await waitFor(() => expect(submitGuestBook).toHaveBeenCalledTimes(1));
	});
});

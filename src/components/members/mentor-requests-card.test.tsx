// @vitest-environment jsdom
/**
 * The dashboard's mentor-request card (#1209), driven the way a mentor drives
 * it. Who may answer and what the server writes is
 * `mentor-requests.integration.test.ts`; this stubs `onDecide`.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMentorRequest } from "#/server/mentorship";
import {
	MENTOR_REQUEST_FAILED_MESSAGE,
	MentorRequestsCard,
} from "./mentor-requests-card";

afterEach(cleanup);

const request = (
	id: string,
	name: string,
	over: Partial<IncomingMentorRequest> = {},
): IncomingMentorRequest => ({
	id,
	focus: "contest",
	focusOther: null,
	createdAt: new Date("2026-10-10T12:00:00Z"),
	mentee: {
		id: `m-${id}`,
		name,
		email: `${name.split(" ")[0]?.toLowerCase()}@example.org`,
		phone: "+15555550122",
		preferredContact: null,
	},
	...over,
});

describe("MentorRequestsCard (#1209)", () => {
	// protects=with no incoming request the card renders nothing; with some, each
	// row names the mentee, the focus as it reads (the free text for other) and
	// the date, with Accept and Decline;
	// fails_when=an empty card shows a bare heading, the focus or date is
	// dropped, or the "other" text is replaced by the label;
	// no_claim=that the rows are the right requests (the integration test)
	it("renders only with a request, one row each", () => {
		const { container, rerender } = render(
			<MentorRequestsCard requests={[]} onDecide={vi.fn()} />,
		);
		expect(container.textContent).toBe("");
		rerender(
			<MentorRequestsCard
				requests={[
					request("r1", "Sam Smith"),
					request("r2", "Dee Doe", { focus: "other", focusOther: "Humor" }),
				]}
				onDecide={vi.fn()}
			/>,
		);
		const rows = container.querySelectorAll("li[data-request]");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.textContent).toContain("Sam Smith");
		expect(rows[0]?.textContent).toContain("Contest");
		expect(rows[0]?.textContent).toContain("Oct 10");
		expect(rows[1]?.textContent).toContain("Humor");
		expect(screen.getAllByRole("button", { name: "Accept" })).toHaveLength(2);
		expect(screen.getAllByRole("button", { name: "Decline" })).toHaveLength(2);
	});

	// protects=Accept calls onDecide(id, true) and the row becomes "Now mentoring
	// {name}. Say hi:" with the welcome draft (a WhatsApp and an Email link built
	// from the mentee's contact), and the row STAYS when the parent's request
	// list no longer holds it (the server stops listing an answered request),
	// until Dismiss;
	// fails_when=Accept never reaches onDecide, the row vanishes with the list,
	// the draft is missing, or Dismiss leaves it;
	// no_claim=what the draft says (nudge.test.ts), that a pairing exists
	it("accept swaps the row for a say-hi draft that outlives the list", async () => {
		const user = userEvent.setup();
		const onDecide = vi.fn().mockResolvedValue(undefined);
		const sam = request("r1", "Sam Smith");
		const { rerender, container } = render(
			<MentorRequestsCard requests={[sam]} onDecide={onDecide} />,
		);
		await user.click(screen.getByRole("button", { name: "Accept" }));
		expect(onDecide).toHaveBeenCalledWith("r1", true);
		await waitFor(() =>
			expect(screen.getByText("Now mentoring Sam Smith. Say hi:")).toBeTruthy(),
		);
		expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
		await waitFor(() => {
			const hrefs = [...container.querySelectorAll("a")].map((a) =>
				a.getAttribute("href"),
			);
			expect(
				hrefs.some((h) => h?.includes("wa.me") || h?.includes("whatsapp")),
			).toBe(true);
			expect(hrefs.some((h) => h?.startsWith("mailto:sam@example.org"))).toBe(
				true,
			);
		});

		rerender(<MentorRequestsCard requests={[]} onDecide={onDecide} />);
		expect(screen.getByText("Now mentoring Sam Smith. Say hi:")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(container.textContent).toBe("");
	});

	// protects=Decline calls onDecide(id, false) and drops the row with no
	// draft; a refused answer (onDecide rejects) shows the server's message in an
	// alert and KEEPS the row and its buttons, never the say-hi draft;
	// fails_when=a refused Accept is treated as accepted, the message is hidden,
	// or a decline leaves the row;
	// no_claim=the wording of the server's refusals (integration test)
	it("decline drops the row; a refused answer keeps it and says why", async () => {
		const user = userEvent.setup();
		const onDecide = vi
			.fn()
			.mockRejectedValueOnce(
				new Error("Sam Smith is no longer an active member."),
			)
			.mockRejectedValueOnce(new Error(""))
			.mockResolvedValue(undefined);
		render(
			<MentorRequestsCard
				requests={[request("r1", "Sam Smith")]}
				onDecide={onDecide}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Accept" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"Sam Smith is no longer an active member.",
		);
		expect(screen.queryByText(/Now mentoring/)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Accept" }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				MENTOR_REQUEST_FAILED_MESSAGE,
			),
		);
		await user.click(screen.getByRole("button", { name: "Decline" }));
		expect(onDecide).toHaveBeenLastCalledWith("r1", false);
		await waitFor(() => expect(screen.queryByText("Sam Smith")).toBeNull());
	});
});

describe("MentorRequestsCard date (#1209)", () => {
	// protects=the row's date is in the club's zone passed in, not UTC;
	// fails_when=02:00 UTC on Oct 10 reads "Oct 10" for a Los Angeles club;
	// no_claim=that the dashboard passes the right zone (dashboard-wiring test)
	it("dates a row in the timezone it is given", () => {
		const { container } = render(
			<MentorRequestsCard
				requests={[
					request("r1", "Sam Smith", {
						createdAt: new Date("2026-10-10T02:00:00Z"),
					}),
				]}
				onDecide={vi.fn()}
				timezone="America/Los_Angeles"
			/>,
		);
		expect(container.textContent).toContain("Contest · Oct 9");
	});
});

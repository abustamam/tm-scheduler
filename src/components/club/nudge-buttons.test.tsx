// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NudgeButtons } from "./nudge-buttons";

const base = {
	name: "Jane",
	roleName: "Timer",
	meetingDate: "Thu, Jul 23",
	shareUrl: "https://gavelup.app/club/mcf/meeting/abc",
	mode: "confirm" as const,
};

describe("NudgeButtons", () => {
	afterEach(() => cleanup());

	it("shows a WhatsApp link when the target has a phone", () => {
		render(<NudgeButtons {...base} phone="14155552671" email={null} />);
		const wa = screen.getByRole("link", { name: /whatsapp/i });
		expect(wa.getAttribute("href")).toContain("https://wa.me/14155552671");
		expect(wa.getAttribute("target")).toBe("_blank");
	});

	it("shows an Email link when the target has an email", () => {
		render(<NudgeButtons {...base} phone={null} email="j@x.io" />);
		const mail = screen.getByRole("link", { name: /email/i });
		expect(mail.getAttribute("href")).toContain("mailto:j@x.io");
	});

	it("shows only the present channel, not a disabled placeholder", () => {
		render(<NudgeButtons {...base} phone={null} email="j@x.io" />);
		expect(screen.queryByRole("link", { name: /whatsapp/i })).toBeNull();
	});

	it("renders a muted no-contact state when neither is present", () => {
		render(<NudgeButtons {...base} phone={null} email={null} />);
		expect(screen.getByText(/no contact on file/i)).toBeTruthy();
		expect(screen.queryByRole("link")).toBeNull();
	});

	it("fires onContacted when the WhatsApp draft link is clicked", async () => {
		const onContacted = vi.fn();
		const user = userEvent.setup();
		render(
			<NudgeButtons
				{...base}
				phone="14155552671"
				email={null}
				onContacted={onContacted}
			/>,
		);
		const wa = await screen.findByRole("link", { name: /whatsapp/i });
		await user.click(wa);
		expect(onContacted).toHaveBeenCalledTimes(1);
	});
});

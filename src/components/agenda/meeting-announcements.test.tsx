// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MeetingAnnouncements } from "./meeting-announcements";

afterEach(cleanup);

describe("MeetingAnnouncements", () => {
	it("renders one list item per non-blank line", () => {
		render(<MeetingAnnouncements text={"Bring a guest\n\nRenew dues"} />);
		expect(screen.getByText("Announcements")).toBeTruthy();
		expect(screen.getByText("Bring a guest")).toBeTruthy();
		expect(screen.getByText("Renew dues")).toBeTruthy();
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
	});

	it("renders nothing when whitespace-only", () => {
		const { container } = render(<MeetingAnnouncements text={"   \n  "} />);
		expect(container.firstChild).toBeNull();
	});

	it("renders nothing when null", () => {
		const { container } = render(<MeetingAnnouncements text={null} />);
		expect(container.firstChild).toBeNull();
	});
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClubHomeHeader } from "./club-home-header";

afterEach(cleanup);

describe("ClubHomeHeader (#542 F-005)", () => {
	it("renders the CLUB NAME as the page's H1 — the wayfinding for guests", () => {
		render(
			<ClubHomeHeader clubName="Harbor City Speakers" memberName="Rasheed" />,
		);
		const h1 = screen.getByRole("heading", { level: 1 });
		expect(h1.textContent).toBe("Harbor City Speakers");
	});

	it("keeps the greeting as a subline, without the emoji", () => {
		const { container } = render(
			<ClubHomeHeader clubName="Harbor City Speakers" memberName="Rasheed" />,
		);
		expect(screen.getByText(/Hi Rasheed/)).toBeTruthy();
		expect(container.textContent).not.toContain("👋");
	});

	it("greets an anonymous visitor as 'there'", () => {
		render(
			<ClubHomeHeader clubName="Harbor City Speakers" memberName={null} />,
		);
		expect(screen.getByText(/Hi there/)).toBeTruthy();
	});
});

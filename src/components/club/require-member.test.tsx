// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequireMember } from "./require-member";

vi.mock("#/server/members", () => ({
	listMembers: vi.fn().mockResolvedValue([
		{ id: "m1", name: "Faisal", office: null },
		{ id: "m2", name: "Mahbuba", office: "President" },
	]),
	addMember: vi.fn().mockResolvedValue({ id: "new-1" }),
}));

function renderGate() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<RequireMember clubId="club-1">
				<div data-testid="protected">protected content</div>
			</RequireMember>
		</QueryClientProvider>,
	);
}

describe("RequireMember", () => {
	afterEach(() => localStorage.clear());

	it("shows the pick-name screen (roster) when no member is stored", async () => {
		renderGate();
		expect(await screen.findByText("Faisal")).toBeTruthy();
		expect(await screen.findByText("Mahbuba")).toBeTruthy();
		expect(screen.queryByTestId("protected")).toBeNull();
	});

	it("renders children after picking a name", async () => {
		renderGate();
		const row = await screen.findByText("Faisal");
		await userEvent.click(row);
		expect(await screen.findByTestId("protected")).toBeTruthy();
	});
});

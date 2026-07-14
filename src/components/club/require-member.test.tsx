// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequireMember } from "./require-member";

vi.mock("#/server/members", () => ({
	listMembers: vi.fn().mockResolvedValue([
		{ id: "m1", name: "Faisal", officerPositions: [] },
		{ id: "m2", name: "Mahbuba", officerPositions: ["president"] },
	]),
	addMember: vi.fn().mockResolvedValue({ id: "new-1" }),
}));

function renderGate() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<RequireMember clubUuid="club-uuid-1" clubSlug="club-1">
				<div data-testid="protected">protected content</div>
			</RequireMember>
		</QueryClientProvider>,
	);
}

describe("RequireMember", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	it("renders skeleton placeholders (not '…') before the identity check runs", () => {
		// renderToString doesn't run effects, so this exercises the SSR /
		// pre-mount branch that browsers paint while the page loads.
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const html = renderToString(
			<QueryClientProvider client={qc}>
				<RequireMember clubUuid="club-uuid-1" clubSlug="club-1">
					<div data-testid="protected">protected content</div>
				</RequireMember>
			</QueryClientProvider>,
		);
		expect(html).toContain('data-slot="skeleton"');
		expect(html).not.toContain("…");
		expect(html).not.toContain("protected content");
	});

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

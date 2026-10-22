// @vitest-environment jsdom
/**
 * Card: protects=the "Connect an AI assistant" block on `/me` is a `<details>`
 * that is CLOSED by default, so a member who never asked for it is not shown a
 * token form (#1281); fails_when=it renders open, loses the title, or renders
 * for a user the server says is not eligible; no_claim=minting and revoking,
 * which the server-fn suites cover.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/db", () => ({ db: {} }));

const { state } = vi.hoisted(() => ({
	state: { eligible: true, tokens: [] as unknown[] },
}));
vi.mock("#/server/api-tokens", () => ({
	getApiTokenState: vi.fn(async () => state),
	generateApiToken: vi.fn(),
	revokeApiTokenFn: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { ApiTokensSection } from "./api-tokens-section";

afterEach(cleanup);

function renderSection() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<ApiTokensSection />
		</QueryClientProvider>,
	);
}

describe("ApiTokensSection", () => {
	it("renders a collapsed details titled Connect an AI assistant", async () => {
		state.eligible = true;
		const { container } = renderSection();
		const title = await screen.findByText("Connect an AI assistant");
		const details = container.querySelector("details");
		expect(details).not.toBeNull();
		expect(details?.open).toBe(false);
		expect(details?.querySelector("summary")?.contains(title)).toBe(true);
	});

	it("renders nothing for an ineligible user", async () => {
		state.eligible = false;
		const { container } = renderSection();
		await new Promise((r) => setTimeout(r, 20));
		expect(container.querySelector("details")).toBeNull();
	});
});

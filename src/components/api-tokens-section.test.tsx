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

	it("tells a ChatGPT user which plans can connect, so a Free or Plus user knows it is the plan", async () => {
		state.eligible = true;
		renderSection();
		await screen.findByText("From Claude or ChatGPT");
		expect(
			await screen.findByText(`${window.location.origin}/api/mcp`),
		).toBeTruthy();
		const chatgpt = screen.getByText("ChatGPT:").parentElement;
		expect(chatgpt?.textContent).toMatch(
			/Business, Enterprise or Edu workspace/,
		);
		expect(chatgpt?.textContent).toMatch(
			/Free, Go and Plus plans can't use GavelUp, and Pro can only read/,
		);
		expect(chatgpt?.textContent).toMatch(/not a problem with your account/);
	});

	it("offers tokens for Claude Code only, the provider the privacy promise names", async () => {
		// `about.tsx` promises club data reaches only the services it lists
		// (Anthropic or OpenAI for assistants). Inviting "other assistants" to
		// take a token would send it somewhere that list doesn't name.
		state.eligible = true;
		renderSection();
		const copy = await screen.findByText(
			/For Claude Code, which takes a token/,
		);
		expect(copy.textContent).not.toMatch(/other assistants/);
	});

	it("renders nothing for an ineligible user", async () => {
		state.eligible = false;
		const { container } = renderSection();
		await new Promise((r) => setTimeout(r, 20));
		expect(container.querySelector("details")).toBeNull();
	});
});

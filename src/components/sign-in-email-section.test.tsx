// @vitest-environment jsdom
//
// The "Sign-in email" section of Account settings (#1091): who gets the form,
// what a submit says, and what a clicked link lands on. The endpoint's own
// refusals are `account-email-change.integration.test.ts`.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getSignInEmailState, $fetch } = vi.hoisted(() => ({
	getSignInEmailState: vi.fn(),
	$fetch: vi.fn(),
}));
vi.mock("#/server/account-email", () => ({ getSignInEmailState }));
vi.mock("#/lib/auth-client", () => ({ authClient: { $fetch } }));

import {
	MEMBER_EMAIL_REQUEST_PATH,
	NEEDS_MERGE_MESSAGE,
} from "#/lib/member-email-change";
import { SignInEmailSection } from "./sign-in-email-section";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderSection(outcome?: string) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<SignInEmailSection outcome={outcome} />
		</QueryClientProvider>,
	);
}

describe("SignInEmailSection", () => {
	it("shows a bound member their address and the change form", async () => {
		getSignInEmailState.mockResolvedValue({
			email: "me@example.com",
			canChange: true,
		});
		renderSection();
		expect(await screen.findByText("me@example.com")).toBeTruthy();
		expect(screen.getByLabelText("New address")).toBeTruthy();
	});

	it("shows an unbound account its address and NO control", async () => {
		getSignInEmailState.mockResolvedValue({
			email: "lone@example.com",
			canChange: false,
		});
		renderSection();
		expect(await screen.findByText("lone@example.com")).toBeTruthy();
		expect(screen.queryByLabelText("New address")).toBeNull();
		expect(screen.queryByRole("button", { name: /send link/i })).toBeNull();
	});

	it("tells an account bound to two Persons why there is no control", async () => {
		getSignInEmailState.mockResolvedValue({
			email: "dup@example.com",
			canChange: false,
			needsMerge: true,
		});
		renderSection();
		expect(await screen.findByText(NEEDS_MERGE_MESSAGE)).toBeTruthy();
		expect(screen.queryByLabelText("New address")).toBeNull();
	});

	it("posts the typed address and says to check the new inbox", async () => {
		getSignInEmailState.mockResolvedValue({
			email: "me@example.com",
			canChange: true,
		});
		$fetch.mockResolvedValue({ data: { status: true }, error: null });
		renderSection();
		await userEvent.type(
			await screen.findByLabelText("New address"),
			"new@example.com",
		);
		await userEvent.click(screen.getByRole("button", { name: /send link/i }));
		expect(
			await screen.findByText(
				/for a link\. Your address changes when you click it/,
			),
		).toBeTruthy();
		expect(screen.getByText("new@example.com")).toBeTruthy();
		expect($fetch).toHaveBeenCalledWith(MEMBER_EMAIL_REQUEST_PATH, {
			method: "POST",
			body: { newEmail: "new@example.com" },
		});
	});

	it("says to try later when the request is rate-limited", async () => {
		getSignInEmailState.mockResolvedValue({
			email: "me@example.com",
			canChange: true,
		});
		$fetch.mockResolvedValue({
			data: null,
			error: {
				status: 429,
				message: "Too many requests. Please try again later.",
			},
		});
		renderSection();
		await userEvent.type(
			await screen.findByLabelText("New address"),
			"new@example.com",
		);
		await userEvent.click(screen.getByRole("button", { name: /send link/i }));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe(
				"Too many requests, try again later.",
			),
		);
	});

	it("reports where a clicked link landed", async () => {
		getSignInEmailState.mockResolvedValue({
			email: "new@example.com",
			canChange: true,
		});
		renderSection("changed");
		expect(
			await screen.findByText(/Your sign-in address was changed/),
		).toBeTruthy();
	});
});

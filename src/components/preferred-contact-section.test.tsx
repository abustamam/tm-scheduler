// @vitest-environment jsdom
//
// The /account card "How should officers reach you?" (#1093). It lists only
// the methods the member's own data supports, plus "No preference"; a member
// with neither email nor phone sees "No preference" alone and a line saying an
// officer can add their phone. The server fns are mocked (they reach `#/db`).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getMyContactPreference, setMyPreferredContact } = vi.hoisted(() => ({
	getMyContactPreference: vi.fn(),
	setMyPreferredContact: vi.fn(),
}));
vi.mock("#/server/contact-preference", () => ({
	getMyContactPreference,
	setMyPreferredContact,
}));

import { PreferredContactSection } from "./preferred-contact-section";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

function renderCard() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={qc}>
			<PreferredContactSection />
		</QueryClientProvider>,
	);
}

function optionLabels(): string[] {
	return screen
		.getAllByRole("radio")
		.map((r) => r.closest("label")?.textContent?.trim() ?? "");
}

describe("PreferredContactSection (#1093)", () => {
	it("lists only available methods plus No preference, with the current one checked", async () => {
		getMyContactPreference.mockResolvedValue({
			linked: true,
			available: ["email", "call", "sms", "whatsapp"],
			preferredContact: "sms",
		});
		renderCard();
		expect(
			await screen.findByText("How should officers reach you?"),
		).toBeTruthy();
		expect(optionLabels()).toEqual([
			"Email",
			"Call",
			"SMS",
			"WhatsApp",
			"No preference",
		]);
		expect(
			(screen.getByRole("radio", { name: "SMS" }) as HTMLInputElement).checked,
		).toBe(true);
	});

	it("offers only email when there is no phone", async () => {
		getMyContactPreference.mockResolvedValue({
			linked: true,
			available: ["email"],
			preferredContact: null,
		});
		renderCard();
		await screen.findByText("How should officers reach you?");
		expect(optionLabels()).toEqual(["Email", "No preference"]);
		expect(
			(screen.getByRole("radio", { name: "No preference" }) as HTMLInputElement)
				.checked,
		).toBe(true);
	});

	it("with neither, offers No preference alone and says an officer can add a phone", async () => {
		getMyContactPreference.mockResolvedValue({
			linked: true,
			available: [],
			preferredContact: null,
		});
		renderCard();
		await screen.findByText("How should officers reach you?");
		expect(optionLabels()).toEqual(["No preference"]);
		expect(
			screen.getByText(/An officer can add your phone number/),
		).toBeTruthy();
	});

	it("saves a pick", async () => {
		getMyContactPreference.mockResolvedValue({
			linked: true,
			available: ["email"],
			preferredContact: null,
		});
		setMyPreferredContact.mockResolvedValue({ ok: true });
		renderCard();
		await screen.findByText("How should officers reach you?");
		fireEvent.click(screen.getByRole("radio", { name: "Email" }));
		await waitFor(() =>
			expect(setMyPreferredContact).toHaveBeenCalledWith({
				data: { preferredContact: "email" },
			}),
		);
	});

	it("saves null for No preference", async () => {
		getMyContactPreference.mockResolvedValue({
			linked: true,
			available: ["email"],
			preferredContact: "email",
		});
		setMyPreferredContact.mockResolvedValue({ ok: true });
		renderCard();
		await screen.findByText("How should officers reach you?");
		fireEvent.click(screen.getByRole("radio", { name: "No preference" }));
		await waitFor(() =>
			expect(setMyPreferredContact).toHaveBeenCalledWith({
				data: { preferredContact: null },
			}),
		);
	});

	it("renders nothing for an account with no club member", async () => {
		getMyContactPreference.mockResolvedValue({
			linked: false,
			available: [],
			preferredContact: null,
		});
		renderCard();
		await waitFor(() => expect(getMyContactPreference).toHaveBeenCalled());
		expect(screen.queryByText("How should officers reach you?")).toBeNull();
	});
});

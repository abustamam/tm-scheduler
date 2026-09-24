// @vitest-environment jsdom
//
// `/request-access` rendered (#866): the kind toggle, the honeypot, what the
// form sends, and the three outcome states. The write path itself — caps,
// insert, notification — is DB-backed and lives in
// `src/server/access-requests.integration.test.ts`.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

// The real module reaches `#/db` → `pg`.
vi.mock("#/server/access-requests", () => ({ submitAccessRequest: vi.fn() }));

import {
	ACCESS_REQUEST_NOTIFY_EMAIL,
	CONTACT_MAILTO,
	PILOT_PRICING_LINE,
} from "#/lib/brand";
import { REF_STORAGE_KEY } from "#/lib/marketing-ref";
import { submitAccessRequest } from "#/server/access-requests";
import { Route } from "./request-access";

const navigate = vi.fn();

async function mount(kind?: string) {
	vi.spyOn(Route, "useSearch").mockReturnValue({ kind } as never);
	vi.spyOn(Route, "useNavigate").mockReturnValue(navigate as never);
	const Component = Route.options.component as React.ComponentType;
	await renderUnderMemoryRouter(<Component />);
}

const type = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });

function fillClub() {
	type("Your name", "Ada Lovelace");
	type("Email", "ada@club.org");
	type("Club name", "Analytical Speakers");
}

beforeEach(() => {
	window.sessionStorage.clear();
	navigate.mockReset();
	vi.mocked(submitAccessRequest).mockReset();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("/request-access (#866)", () => {
	it("toggles between the club and district forms and puts the kind in the URL", async () => {
		await mount();
		expect(screen.getByText(PILOT_PRICING_LINE)).toBeTruthy();
		expect(screen.getByLabelText("Club name")).toBeTruthy();
		expect(screen.queryByLabelText("District number")).toBeNull();

		fireEvent.click(screen.getByRole("tab", { name: "A district" }));
		expect(screen.getByLabelText("District number")).toBeTruthy();
		expect(screen.queryByLabelText("Club name")).toBeNull();
		expect(navigate).toHaveBeenCalledWith(
			expect.objectContaining({ search: { kind: "district" }, replace: true }),
		);
	});

	it("opens on the district form when the URL says so, and on club for anything else", async () => {
		await mount("district");
		expect(screen.getByLabelText("District number")).toBeTruthy();
		cleanup();
		await mount("nonsense");
		expect(screen.getByLabelText("Club name")).toBeTruthy();
	});

	it("keeps the honeypot out of reach and sends it, the ref and renderedAt with the form", async () => {
		window.sessionStorage.setItem(REF_STORAGE_KEY, "district-57");
		vi.mocked(submitAccessRequest).mockResolvedValue({ ok: true });
		await mount();

		const honeypot = document.getElementById("ra-website") as HTMLInputElement;
		expect(honeypot.tabIndex).toBe(-1);
		expect(honeypot.getAttribute("autocomplete")).toBe("off");
		expect(honeypot.closest("[aria-hidden='true']")?.className).toContain(
			"sr-only",
		);

		fillClub();
		fireEvent.click(screen.getByRole("button", { name: "Send request" }));

		await screen.findByText("Thanks! We'll be in touch within a few days.");
		const sent = vi.mocked(submitAccessRequest).mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(sent.data).toMatchObject({
			kind: "club",
			name: "Ada Lovelace",
			email: "ada@club.org",
			clubName: "Analytical Speakers",
			ref: "district-57",
			website: "",
		});
		expect(sent.data).not.toHaveProperty("districtNumber");
		expect(typeof sent.data.renderedAt).toBe("number");
		expect(sent.data.renderedAt as number).toBeGreaterThan(0);
	});

	it("shows the already-received and busy states, busy with a contact link", async () => {
		vi.mocked(submitAccessRequest).mockResolvedValue({
			ok: true,
			alreadyReceived: true,
		});
		await mount();
		fillClub();
		fireEvent.click(screen.getByRole("button", { name: "Send request" }));
		await screen.findByText(
			"We already have your request. We'll be in touch soon.",
		);

		cleanup();
		vi.mocked(submitAccessRequest).mockResolvedValue({
			ok: false,
			reason: "busy",
		});
		await mount();
		fillClub();
		fireEvent.click(screen.getByRole("button", { name: "Send request" }));
		const link = await screen.findByRole("link", { name: "email us" });
		expect(link.getAttribute("href")).toBe(CONTACT_MAILTO);
		await waitFor(() =>
			expect(
				screen.getByText(/We're getting a lot of requests right now/),
			).toBeTruthy(),
		);
	});

	it("names the notification inbox in the contact mailto (one inbox, two constants)", () => {
		// Parsed, not rebuilt: `mailto.guard.test.ts` forbids gluing a value onto
		// the scheme anywhere outside `src/lib/mailto.ts`, tests included.
		const url = new URL(CONTACT_MAILTO);
		expect(url.protocol).toBe("mailto:");
		expect(url.pathname).toBe(ACCESS_REQUEST_NOTIFY_EMAIL);
		expect(url.searchParams.get("subject")).toBe("GavelUp");
	});
});

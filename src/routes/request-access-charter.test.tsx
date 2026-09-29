// @vitest-environment jsdom
//
// `/request-access`'s charter question (#944): optional, sent only when the
// visitor answers it, and never sent on a district request.
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/access-requests", () => ({ submitAccessRequest: vi.fn() }));

import { CHARTER_OPTIONS } from "#/lib/club-charter";
import { submitAccessRequest } from "#/server/access-requests";
import { Route } from "./request-access";

async function mount(kind?: string) {
	vi.spyOn(Route, "useSearch").mockReturnValue({ kind } as never);
	vi.spyOn(Route, "useNavigate").mockReturnValue(vi.fn() as never);
	const Component = Route.options.component as React.ComponentType;
	await renderUnderMemoryRouter(<Component />);
}

const type = (label: string, value: string) =>
	fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function submitClub(charter?: string): Promise<Record<string, unknown>> {
	await mount();
	type("Your name", "Ada Lovelace");
	type("Email", "ada@club.org");
	type("Club name", "Analytical Speakers");
	if (charter !== undefined)
		type("Has your club chartered?(optional)", charter);
	// A chartered club is asked for its number (a client-side requirement).
	if (charter === "chartered") type("Club number", "1234567");
	fireEvent.click(screen.getByRole("button", { name: "Send request" }));
	await screen.findByText("Thanks! We'll be in touch within a few days.");
	return (
		vi.mocked(submitAccessRequest).mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		}
	).data;
}

beforeEach(() => {
	vi.mocked(submitAccessRequest).mockReset();
	vi.mocked(submitAccessRequest).mockResolvedValue({ ok: true });
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("/request-access charter question (#944)", () => {
	it("is optional and starts unanswered", async () => {
		await mount();
		const select = screen.getByLabelText(
			"Has your club chartered?(optional)",
		) as HTMLSelectElement;
		expect(select.value).toBe("");
		expect(select.required).toBe(false);
		expect(CHARTER_OPTIONS.map((o) => o.value)).toEqual([
			"",
			"chartered",
			"chartering",
		]);
	});

	it("sends chartering when the club is still forming", async () => {
		const data = await submitClub("chartering");
		expect(data.charterStatus).toBe("chartering");
	});

	it("sends chartered", async () => {
		const data = await submitClub("chartered");
		expect(data.charterStatus).toBe("chartered");
	});

	it("sends nothing when the visitor did not say", async () => {
		const data = await submitClub();
		expect(data).not.toHaveProperty("charterStatus");
	});

	it("marks the club number required once chartered is picked, and optional otherwise", async () => {
		await mount();
		const number = () =>
			screen.getByLabelText(/^Club number/) as HTMLInputElement;
		const label = () =>
			document.querySelector("label[for='ra-club-number']")?.textContent;
		expect(number().required).toBe(false);
		expect(label()).toBe("Club number(optional)");
		type("Has your club chartered?(optional)", "chartered");
		expect(number().required).toBe(true);
		expect(label()).toBe("Club number");
		type("Has your club chartered?(optional)", "chartering");
		expect(number().required).toBe(false);
	});

	it("is not asked on a district request", async () => {
		await mount("district");
		expect(screen.queryByLabelText(/Has your club chartered/)).toBeNull();
	});
});

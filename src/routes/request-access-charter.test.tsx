// @vitest-environment jsdom
//
// `/request-access`'s charter question (#944): optional, sent only when the
// visitor answers it, and never sent on a district request.
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/access-requests", () => ({ submitAccessRequest: vi.fn() }));

import { submitAccessRequest } from "#/server/access-requests";
import { CHARTER_OPTIONS, Route } from "./request-access";

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

	it("is not asked on a district request", async () => {
		await mount("district");
		expect(screen.queryByLabelText(/Has your club chartered/)).toBeNull();
	});
});

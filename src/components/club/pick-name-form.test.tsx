// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/members", () => ({
	listMembers: vi.fn(async () => [
		{
			id: "m-jose",
			name: "José Ruiz",
			preferredName: null,
			officerPositions: ["vp_education"],
		},
		{
			id: "m-rob",
			name: "Robert Smith",
			preferredName: "Bob",
			officerPositions: [],
		},
	]),
}));

import { PickNameForm } from "./pick-name-form";

class RO {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

function setup() {
	const onPicked = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient()}>
			<PickNameForm
				clubUuid="c1"
				onPicked={onPicked}
				notListedHint={<p>Not on the list?</p>}
			/>
		</QueryClientProvider>,
	);
	return { onPicked, user: userEvent.setup() };
}

describe("PickNameForm (#1333)", () => {
	// protects=an unaccented query finds an accented name; fails_when=matching reverts to name.includes; no_claim=ranking order
	it("finds José Ruiz by 'jose'", async () => {
		const { user } = setup();
		await screen.findByText(/José Ruiz/);
		await user.type(screen.getByPlaceholderText("Type your name…"), "jose");
		expect(screen.getByText(/José Ruiz/)).toBeTruthy();
		expect(screen.queryByText(/Robert Smith/)).toBeNull();
		expect(screen.getByText("VP Education")).toBeTruthy();
	});

	// protects=a preferred name finds the member and shows "goes by"; fails_when=preferredName is not passed to the matcher; no_claim=the member is not renamed
	it("finds Robert Smith by his preferred name 'bob' and shows 'goes by Bob'", async () => {
		const { user, onPicked } = setup();
		await screen.findByText(/Robert Smith/);
		await user.type(screen.getByPlaceholderText("Type your name…"), "bob");
		expect(screen.getByText(/goes by Bob/)).toBeTruthy();
		await user.click(screen.getByText(/Robert Smith/));
		expect(onPicked).toHaveBeenCalledWith({
			id: "m-rob",
			name: "Robert Smith",
		});
	});

	// protects=picking calls onPicked with exactly {id,name} and no match shows the empty copy plus the hint; fails_when=the payload gains fields or the empty text/hint is dropped; no_claim=nothing is stored here
	it("picks with {id,name}, and shows the empty text and the hint on no match", async () => {
		const { user, onPicked } = setup();
		await screen.findByText(/José Ruiz/);
		await user.click(screen.getByText(/José Ruiz/));
		expect(onPicked).toHaveBeenCalledWith({ id: "m-jose", name: "José Ruiz" });
		await user.type(screen.getByPlaceholderText("Type your name…"), "zzz");
		expect(screen.getByText("No members match.")).toBeTruthy();
		expect(screen.getByText("Not on the list?")).toBeTruthy();
	});
});

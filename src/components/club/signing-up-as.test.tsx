// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memberKey } from "#/lib/member-identity";
import { RequireMember } from "./require-member";
import { SigningUpAs } from "./signing-up-as";

// RequireMember's pick-name screen queries the roster via the members
// server-fn module; stub it so the "returns to the gate" test can render.
vi.mock("#/server/members", () => ({
	listMembers: vi.fn().mockResolvedValue([
		{ id: "m1", name: "Alex Rivera", officerPositions: [] },
		{ id: "m2", name: "Jordan Lee", officerPositions: [] },
	]),
	addMember: vi.fn().mockResolvedValue({ id: "new-1" }),
}));

const CLUB = "club-1";

function storeIdentity(clubSlug = CLUB, name = "Alex Rivera") {
	localStorage.setItem(memberKey(clubSlug), JSON.stringify({ id: "m1", name }));
}

describe("SigningUpAs", () => {
	afterEach(() => {
		cleanup();
		localStorage.clear();
	});

	it("shows 'Signing up as {name}' with a 'not you?' control when an identity is stored", () => {
		storeIdentity();
		render(<SigningUpAs clubSlug={CLUB} />);
		expect(screen.getByText(/Signing up as/)).toBeTruthy();
		expect(screen.getByText("Alex Rivera")).toBeTruthy();
		expect(screen.getByRole("button", { name: "not you?" })).toBeTruthy();
	});

	it("renders nothing when no identity is stored", () => {
		const { container } = render(<SigningUpAs clubSlug={CLUB} />);
		expect(container.innerHTML).toBe("");
	});

	it("renders nothing for an identity stored under a different club", () => {
		storeIdentity("some-other-club");
		const { container } = render(<SigningUpAs clubSlug={CLUB} />);
		expect(container.innerHTML).toBe("");
	});

	it("'not you?' clears that club's stored identity and removes the line", async () => {
		storeIdentity();
		render(<SigningUpAs clubSlug={CLUB} />);
		await userEvent.click(screen.getByRole("button", { name: "not you?" }));
		expect(localStorage.getItem(memberKey(CLUB))).toBeNull();
		expect(screen.queryByText(/Signing up as/)).toBeNull();
	});

	it("'not you?' returns the visitor to the 'Who are you?' gate (via RequireMember)", async () => {
		storeIdentity();
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={qc}>
				<RequireMember clubUuid="club-uuid-1" clubSlug={CLUB}>
					<SigningUpAs clubSlug={CLUB} />
				</RequireMember>
			</QueryClientProvider>,
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "not you?" }),
		);
		expect(await screen.findByText("Who are you?")).toBeTruthy();
		expect(screen.queryByText(/Signing up as/)).toBeNull();
	});
});

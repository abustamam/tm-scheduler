// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { memberKey } from "#/lib/member-identity";
import { SigningUpAs } from "./signing-up-as";

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
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ViewingAs } from "./viewing-as";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("ViewingAs", () => {
	it("guest state invites the visitor to identify", async () => {
		const promptIdentity = vi.fn();
		render(<ViewingAs member={null} promptIdentity={promptIdentity} />);
		expect(screen.getByText(/viewing as guest/i)).toBeTruthy();
		await userEvent.click(
			screen.getByRole("button", { name: /i'm a member/i }),
		);
		expect(promptIdentity).toHaveBeenCalledOnce();
	});

	it("identified state shows the name and a switch affordance", async () => {
		const promptIdentity = vi.fn();
		render(
			<ViewingAs
				member={{ id: "m1", name: "Jane Doe" }}
				promptIdentity={promptIdentity}
			/>,
		);
		expect(screen.getByText(/jane doe/i)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /not you/i }));
		expect(promptIdentity).toHaveBeenCalledOnce();
	});
});

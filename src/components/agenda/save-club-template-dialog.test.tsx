// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	REPLACE_SAVED_MESSAGE,
	SaveClubTemplateDialog,
} from "./save-club-template-dialog";

afterEach(cleanup);

const CLUB_TEMPLATES = [
	{ id: "11111111-1111-4111-8111-111111111111", name: "Contest night" },
];

function renderDialog(
	overrides: Partial<Parameters<typeof SaveClubTemplateDialog>[0]> = {},
) {
	const onSave = vi.fn(async () => {});
	const onOpenChange = vi.fn();
	render(
		<SaveClubTemplateDialog
			open
			onOpenChange={onOpenChange}
			clubTemplates={CLUB_TEMPLATES}
			onSave={onSave}
			{...overrides}
		/>,
	);
	return { onSave, onOpenChange };
}

describe("SaveClubTemplateDialog", () => {
	it("saves as new with a trimmed name, and refuses an empty or over-long one", async () => {
		const user = userEvent.setup();
		const { onSave, onOpenChange } = renderDialog();

		await user.click(screen.getByRole("button", { name: "Save template" }));
		expect(screen.getByRole("alert").textContent).toBe(
			"Give the template a name.",
		);

		const nameBox = screen.getByLabelText("Name");
		await user.type(nameBox, "x".repeat(81));
		await user.click(screen.getByRole("button", { name: "Save template" }));
		expect(screen.getByRole("alert").textContent).toMatch(/too long \(max 80/);
		expect(onSave).not.toHaveBeenCalled();

		await user.clear(nameBox);
		await user.type(nameBox, "  Contest night  ");
		await user.type(screen.getByLabelText("Description (optional)"), "  ");
		await user.click(screen.getByRole("button", { name: "Save template" }));
		expect(onSave).toHaveBeenCalledWith({
			mode: "new",
			name: "Contest night",
			description: null,
		});
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});

	it("replaces a chosen club template and confirms earlier meetings keep their copy", async () => {
		const user = userEvent.setup();
		const { onSave, onOpenChange } = renderDialog();

		await user.click(
			screen.getByLabelText("Replace one of your club's templates"),
		);
		await user.click(screen.getByRole("button", { name: "Replace template" }));
		expect(screen.getByRole("alert").textContent).toBe(
			"Choose the template to replace.",
		);

		await user.selectOptions(
			screen.getByLabelText("Template to replace"),
			CLUB_TEMPLATES[0]?.id as string,
		);
		await user.click(screen.getByRole("button", { name: "Replace template" }));
		expect(onSave).toHaveBeenCalledWith({
			mode: "replace",
			templateId: CLUB_TEMPLATES[0]?.id,
		});
		expect(
			(await screen.findByTestId("save-club-template-replaced")).textContent,
		).toBe(REPLACE_SAVED_MESSAGE);
		// A replace stays open to say so; it does not close on its own.
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	it("disables replace when the club has no templates, and shows a server refusal", async () => {
		const user = userEvent.setup();
		const onSave = vi.fn(async () => {
			throw new Error("That club template no longer exists.");
		});
		renderDialog({ clubTemplates: [], onSave });
		expect(
			(
				screen.getByLabelText(
					"Replace one of your club's templates",
				) as HTMLInputElement
			).disabled,
		).toBe(true);
		expect(
			screen.getByText("Your club has no templates of its own yet."),
		).toBeTruthy();

		await user.type(screen.getByLabelText("Name"), "Contest night");
		await user.click(screen.getByRole("button", { name: "Save template" }));
		expect((await screen.findByRole("alert")).textContent).toBe(
			"That club template no longer exists.",
		);
	});
});

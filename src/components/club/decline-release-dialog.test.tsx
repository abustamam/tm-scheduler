// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DeclineReleaseDialog,
	type PendingDecline,
} from "#/components/club/decline-release-dialog";

/**
 * The confirm step between "Not coming" and the roles going back to the open
 * pool (#663).
 *
 * The assertions are on the COPY, deliberately, because the copy is the whole
 * feature: the release is not reversible from the meeting page, so what makes
 * this dialog worth its tap is that it names the roles the officer is about to
 * empty. A test that only checked the dialog opened would pass for "This frees 2
 * roles", which is the version that reads fine in review and is useless in the
 * room — the officer's next question is always WHICH.
 */
function pending(over: Partial<PendingDecline> = {}): PendingDecline {
	return {
		memberId: "m1",
		name: "Ana Ruiz",
		roleLabels: ["Toastmaster of the Day"],
		self: false,
		...over,
	};
}

describe("DeclineReleaseDialog (#663)", () => {
	// vitest here runs without `globals`, so testing-library's auto-cleanup never
	// registers and renders leak between tests.
	afterEach(() => cleanup());

	it("renders nothing until a decline is pending", () => {
		const { queryByRole } = render(
			<DeclineReleaseDialog
				pending={null}
				onCancel={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);
		expect(queryByRole("dialog")).toBeNull();
	});

	it("NAMES every role being freed, not a count", () => {
		const { getByRole } = render(
			<DeclineReleaseDialog
				pending={pending({
					roleLabels: ["Toastmaster of the Day", "Evaluator 2"],
				})}
				onCancel={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);
		const dialog = getByRole("dialog");
		expect(dialog.textContent).toContain("Toastmaster of the Day");
		expect(dialog.textContent).toContain("Evaluator 2");
		// The Oxford-comma-aware shared formatter, so the same club's roles read
		// the same here and on the agenda.
		expect(dialog.textContent).toContain(
			"Toastmaster of the Day and Evaluator 2",
		);
	});

	it("says the release cannot be undone", () => {
		// The reason a confirm exists at all: nothing on the meeting page puts a
		// released slot back, so an officer who only meant to record a decline must
		// be told before, not after.
		const { getByRole } = render(
			<DeclineReleaseDialog
				pending={pending()}
				onCancel={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);
		expect(getByRole("dialog").textContent).toContain(
			"can't put it back automatically",
		);
	});

	it("names the SUBJECT when an officer acts on someone else", () => {
		const { getByRole } = render(
			<DeclineReleaseDialog
				pending={pending()}
				onCancel={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);
		const text = getByRole("dialog").textContent ?? "";
		expect(text).toContain("Mark Ana Ruiz not coming?");
		expect(text).toContain("Ana Ruiz is Toastmaster of the Day");
	});

	it("switches to first person on the member's own row", () => {
		// Same component, both surfaces: the rail's chips act on someone else, the
		// personal strip acts on the viewer. Third-person copy there would read as
		// if someone else were doing it to them.
		const { getByRole } = render(
			<DeclineReleaseDialog
				pending={pending({ self: true })}
				onCancel={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);
		const text = getByRole("dialog").textContent ?? "";
		expect(text).toContain("Mark yourself not coming?");
		expect(text).toContain("You're Toastmaster of the Day");
		expect(text).not.toContain("Ana Ruiz");
	});

	it("agrees with itself about singular and plural", () => {
		// One array drives the pronoun, the noun and the button, so a member holding
		// exactly one role never reads "those roles … put them back".
		const { getByRole, getByText } = render(
			<DeclineReleaseDialog
				pending={pending({ roleLabels: ["Timer", "Grammarian"] })}
				onCancel={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);
		const text = getByRole("dialog").textContent ?? "";
		expect(text).toContain("frees those roles");
		expect(text).toContain("can't put them back automatically");
		getByText("Not coming & free the roles");
	});

	it("hands the pending decline back on confirm, and nothing on cancel", async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const p = pending();
		const { getByText } = render(
			<DeclineReleaseDialog
				pending={p}
				onCancel={onCancel}
				onConfirm={onConfirm}
			/>,
		);
		await userEvent.click(getByText("Not coming & free the role"));
		expect(onConfirm).toHaveBeenCalledWith(p);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("cancels without confirming", async () => {
		// The half that matters: a cancel that also wrote would make the confirm a
		// decoration.
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const { getByText } = render(
			<DeclineReleaseDialog
				pending={pending()}
				onCancel={onCancel}
				onConfirm={onConfirm}
			/>,
		);
		await userEvent.click(getByText("Cancel"));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("cancels when the dialog is dismissed", async () => {
		// Escape / overlay close must clear the pending decline too, or the next
		// pick reopens a dialog the officer already walked away from.
		const onCancel = vi.fn();
		render(
			<DeclineReleaseDialog
				pending={pending()}
				onCancel={onCancel}
				onConfirm={vi.fn()}
			/>,
		);
		await userEvent.keyboard("{Escape}");
		expect(onCancel).toHaveBeenCalled();
	});
});

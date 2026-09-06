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
 * feature: the release is not reversible from the meeting page — re-claiming a
 * freed slot mints a NEW speech row rather than reattaching the old one — so
 * what makes this dialog worth its tap is that it names the roles the officer is
 * about to empty. A test that only checked the dialog opened would pass for
 * "This frees 2 roles", which is the version that reads fine in review and is
 * useless in the room: the officer's next question is always WHICH.
 */
function pending(over: Partial<PendingDecline> = {}): PendingDecline {
	return {
		memberId: "m1",
		name: "Ana Ruiz",
		roleLabels: ["Toastmaster of the Day"],
		self: false,
		willRelease: true,
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
		getByText("Keep the roles");
	});

	describe("when the page knows of no role", () => {
		// The case the first cut skipped entirely. `roleLabels` comes from loader
		// data and the rail does not poll, so an empty list means "we did not see
		// one", never "there isn't one" — the server frees a slot claimed since the
		// page rendered whether or not this dialog mentioned it.
		it("still opens, and warns without naming anything", () => {
			const { getByRole } = render(
				<DeclineReleaseDialog
					pending={pending({ roleLabels: [] })}
					onCancel={vi.fn()}
					onConfirm={vi.fn()}
				/>,
			);
			const text = getByRole("dialog").textContent ?? "";
			expect(text).toContain("any role Ana Ruiz has taken");
			expect(text).toContain("can't put it back automatically");
		});

		it("does not promise a specific role on the button either", () => {
			const { getByText } = render(
				<DeclineReleaseDialog
					pending={pending({ roleLabels: [] })}
					onCancel={vi.fn()}
					onConfirm={vi.fn()}
				/>,
			);
			getByText("Not coming & free any role");
		});
	});

	describe("when this caller's arm frees nothing", () => {
		// A self-asserted Toastmaster acting on someone else. The server records
		// the rung and keeps the slot, so promising a release here would be the
		// silent divergence in the other direction.
		it("says the role stays theirs", () => {
			const { getByRole } = render(
				<DeclineReleaseDialog
					pending={pending({ willRelease: false })}
					onCancel={vi.fn()}
					onConfirm={vi.fn()}
				/>,
			);
			const text = getByRole("dialog").textContent ?? "";
			expect(text).toContain("That stays theirs");
			expect(text).not.toContain("frees");
			expect(text).not.toContain("put it back");
		});

		it("offers a plain confirm, not a destructive one", () => {
			const { getByText } = render(
				<DeclineReleaseDialog
					pending={pending({ willRelease: false })}
					onCancel={vi.fn()}
					onConfirm={vi.fn()}
				/>,
			);
			getByText("Mark not coming");
			getByText("Never mind");
		});
	});

	it("marks the freeing confirm as destructive", () => {
		// Below `sm` the footer is `flex-col-reverse`, so this button is the TOP of
		// the stack — the first thing a thumb reaches on the phone this rail is run
		// from. The default variant there reads as the safe choice.
		const { getByText } = render(
			<DeclineReleaseDialog
				pending={pending()}
				onCancel={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);
		const confirm = getByText("Not coming & free the role");
		expect(confirm.className).toContain("destructive");
		// And the way OUT names the outcome, rather than saying "Cancel" next to a
		// button that frees a role.
		getByText("Keep the role");
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
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const { getByText } = render(
			<DeclineReleaseDialog
				pending={pending()}
				onCancel={onCancel}
				onConfirm={onConfirm}
			/>,
		);
		await userEvent.click(getByText("Keep the role"));
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onConfirm).not.toHaveBeenCalled();
	});

	it("cancels when the dialog is dismissed", async () => {
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

	describe("while the confirmed write is in flight", () => {
		it("disables both controls", () => {
			const { getByText } = render(
				<DeclineReleaseDialog
					pending={pending()}
					busy
					onCancel={vi.fn()}
					onConfirm={vi.fn()}
				/>,
			);
			expect(
				getByText("Not coming & free the role").hasAttribute("disabled"),
			).toBe(true);
			expect(getByText("Keep the role").hasAttribute("disabled")).toBe(true);
		});

		it("cannot be dismissed out from under the write", async () => {
			// Escape and the overlay both route through `onOpenChange`. Dismissing
			// mid-flight leaves the officer with no idea whether it landed.
			const onCancel = vi.fn();
			render(
				<DeclineReleaseDialog
					pending={pending()}
					busy
					onCancel={onCancel}
					onConfirm={vi.fn()}
				/>,
			);
			await userEvent.keyboard("{Escape}");
			expect(onCancel).not.toHaveBeenCalled();
		});
	});

	// NOT tested here: the "Mark undefined not coming?" flash during the closing
	// animation. Radix keeps the content mounted for the exit transition, and
	// jsdom runs no CSS animations — `getComputedStyle(node).animationName` is
	// "", so Presence unmounts on the same tick and the intermediate render this
	// bug lives in never happens in the harness. A test here passes identically
	// with the fix reverted, which is the shape CODING_STANDARDS.md calls a guard
	// that cannot fail. The fix reads one narrow interface (the copy is derived
	// from a held value, not from the live prop) and
	// `decline-release-wiring.guard.test.ts` drives THAT instead.
});

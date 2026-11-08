// @vitest-environment jsdom
//
// The guest invite template editor (#1547): the preview, what Save sends, and
// the draft Save/Reset keep per tab. Server fns are mocked; the preview runs the
// real `buildNudge`, so it cannot disagree with the real draft.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("#/server/guest-invite-template", () => ({
	updateGuestInviteTemplates: vi.fn(async () => ({ ok: true })),
	resetGuestInviteTemplate: vi.fn(async () => ({ ok: true })),
}));

import type { GuestInviteTemplates } from "#/lib/guest-invite-template";
import { updateGuestInviteTemplates } from "#/server/guest-invite-template";
import { GuestInviteTemplateEditor } from "./guest-invite-template-editor";

const CLUB = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
	cleanup();
	vi.mocked(updateGuestInviteTemplates).mockReset();
	vi.mocked(updateGuestInviteTemplates).mockResolvedValue({ ok: true });
});

function renderEditor(templates: GuestInviteTemplates = {}) {
	const onSaved = vi.fn(async () => {});
	render(
		<GuestInviteTemplateEditor
			clubId={CLUB}
			templates={templates}
			timezone="UTC"
			onSaved={onSaved}
		/>,
	);
	return { user: userEvent.setup(), onSaved };
}

const sentTemplates = (call = 0) =>
	(
		vi.mocked(updateGuestInviteTemplates).mock.calls[call]?.[0] as {
			data: { clubId: string; templates: GuestInviteTemplates };
		}
	).data.templates;

describe("the preview", () => {
	// protects=an email subject containing a percent sign previews as typed;
	// fails_when=the preview percent-decodes an already-decoded subject (URIError);
	// no_claim=the mailto the real draft opens (nudge.test.ts).
	it("shows a subject with a % in it instead of throwing", () => {
		renderEditor({ never: { subject: "50% off at {club}" } });
		expect(screen.getByTestId("guest-invite-preview-subject").textContent).toBe(
			"50% off at Your Club",
		);
	});

	// protects=decision A in the preview: a second line shows the draft with no
	// venue; fails_when=it is missing, or an edited default leaves ", at ." behind;
	// no_claim=the venue-set message, which keeps its location.
	it("shows the no-location result without a dangling ', at'", async () => {
		renderEditor();
		const withLocation = screen.getByTestId("guest-invite-preview-message");
		expect(withLocation.textContent).toContain(", at Community Library");
		const none = screen.getByTestId("guest-invite-preview-no-location");
		expect(none.textContent).not.toMatch(/, at/);
		expect(none.textContent).toContain("Agenda:");
	});
});

describe("an edited default in the preview", () => {
	// protects=decision A for an EDITED text: ", at {location}" collapses with no
	// venue and stays with one; fails_when=the clause is left dangling (", at .");
	// no_claim=the built-in text (above).
	it("collapses ', at {location}' only in the no-location line", () => {
		renderEditor({ never: { body: "Meet at 6, at {location}." } });
		expect(screen.getByTestId("guest-invite-preview-message").textContent).toBe(
			"Meet at 6, at Community Library, Room 2.",
		);
		expect(
			screen.getByTestId("guest-invite-preview-no-location").textContent,
		).toBe("Meet at 6.");
	});
});

describe("Save", () => {
	// protects=decision B: only the drafts this form changed are sent, so the
	// server's merge cannot overwrite another officer's other drafts;
	// fails_when=every kind is sent (the unchanged ones go too);
	// no_claim=the merge itself (guest-invite-template.integration.test.ts).
	it("sends only the changed drafts, then only what changed since", async () => {
		const { user } = renderEditor();
		const body = screen.getByLabelText("Message");
		await user.clear(body);
		await user.type(body, "Never body");
		await user.click(
			screen.getByRole("button", { name: "Save guest invites" }),
		);
		await waitFor(() =>
			expect(updateGuestInviteTemplates).toHaveBeenCalledTimes(1),
		);
		expect(Object.keys(sentTemplates(0))).toEqual(["never"]);

		await user.click(screen.getByRole("tab", { name: "Lapsed" }));
		const lapsed = screen.getByLabelText("Message");
		await user.clear(lapsed);
		await user.type(lapsed, "Lapsed body");
		await user.click(
			screen.getByRole("button", { name: "Save guest invites" }),
		);
		await waitFor(() =>
			expect(updateGuestInviteTemplates).toHaveBeenCalledTimes(2),
		);
		expect(Object.keys(sentTemplates(1))).toEqual(["lapsed"]);
	});

	// protects=text typed while a save is in flight stays "changed";
	// fails_when=the baseline becomes the live fields rather than what was sent, so
	// Discard disappears and the extra text is never saved;
	// no_claim=the order of two saves.
	it("keeps text typed during a save as an unsaved change", async () => {
		let release: (v: { ok: true }) => void = () => {};
		vi.mocked(updateGuestInviteTemplates).mockImplementation(
			() => new Promise((r) => (release = r)),
		);
		const { user } = renderEditor();
		const body = screen.getByLabelText("Message");
		await user.clear(body);
		await user.type(body, "First");
		await user.click(
			screen.getByRole("button", { name: "Save guest invites" }),
		);
		await user.type(body, " and more");
		release({ ok: true });
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Save guest invites" }),
			).toHaveProperty("disabled", false),
		);
		expect(
			screen.getByRole("button", { name: "Discard changes" }),
		).toBeTruthy();
	});
});

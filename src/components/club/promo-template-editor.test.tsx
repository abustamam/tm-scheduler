// @vitest-environment jsdom
//
// The club's blast template editor (#931): what Save sends, the per-channel
// toggles, the unknown-placeholder warning, and Reset.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/promo", () => ({
	updatePromoTemplate: vi.fn(async () => ({ ok: true })),
	resetPromoTemplate: vi.fn(async () => ({ ok: true })),
	getPromoContext: vi.fn(),
}));

import { DEFAULT_PROMO_TEMPLATE, toEditorText } from "#/lib/promo-template";
import {
	getPromoContext,
	resetPromoTemplate,
	updatePromoTemplate,
} from "#/server/promo";
import { bulletsFromText, PromoTemplateEditor } from "./promo-template-editor";

const CLUB = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
	// Most tests do not care about the context: it fails quietly.
	vi.mocked(getPromoContext).mockRejectedValue(new Error("no context"));
});

afterEach(() => {
	cleanup();
	vi.mocked(updatePromoTemplate).mockClear();
	vi.mocked(resetPromoTemplate).mockClear();
	vi.mocked(getPromoContext).mockReset();
});

function renderEditor(
	template: typeof DEFAULT_PROMO_TEMPLATE = DEFAULT_PROMO_TEMPLATE,
) {
	const onSaved = vi.fn(async () => {});
	render(
		<PromoTemplateEditor clubId={CLUB} template={template} onSaved={onSaved} />,
	);
	return { user: userEvent.setup(), onSaved };
}

describe("PromoTemplateEditor", () => {
	it("a new club's editor shows the seeded default", () => {
		renderEditor();
		// The editor shows the friendly form of the stored `{club}, {date}`.
		expect(
			(screen.getByLabelText("Headline") as HTMLTextAreaElement).value,
		).toBe("You're invited: {Club name}, {Date}");
		expect(
			(screen.getByLabelText("Why join (one per line)") as HTMLTextAreaElement)
				.value,
		).toBe(DEFAULT_PROMO_TEMPLATE.whyJoin.join("\n"));
	});

	it("Save sends the edited template, bullets one per line and toggles applied", async () => {
		const { user, onSaved } = renderEditor();
		const headline = screen.getByLabelText("Headline");
		await user.clear(headline);
		await user.type(headline, "Come to {{Club name}");
		const why = screen.getByLabelText("Why join (one per line)");
		await user.clear(why);
		await user.type(why, "Speak{enter}{enter}  Lead  ");
		await user.click(screen.getByLabelText("Why join in WhatsApp"));
		await user.click(
			screen.getByRole("button", { name: /save promo template/i }),
		);
		await waitFor(() => expect(updatePromoTemplate).toHaveBeenCalledTimes(1));
		const sent = vi.mocked(updatePromoTemplate).mock.calls[0]?.[0] as {
			data: { clubId: string; template: typeof DEFAULT_PROMO_TEMPLATE };
		};
		expect(sent.data.clubId).toBe(CLUB);
		expect(sent.data.template.headline).toBe("Come to {club}");
		expect(sent.data.template.whyJoin).toEqual(["Speak", "Lead"]);
		expect(sent.data.template.channels.whatsapp.whyJoin).toBe(false);
		expect(sent.data.template.channels.email.whyJoin).toBe(true);
		expect(onSaved).toHaveBeenCalled();
	});

	it("flags an unknown variable under its field while typing", async () => {
		const { user } = renderEditor();
		expect(screen.queryByText(/Not a variable/)).toBeNull();
		await user.type(screen.getByLabelText("Call to action"), " {{rsvp}");
		expect(screen.getByText(/Not a variable: \{rsvp\}/)).toBeTruthy();
	});

	it("refuses a blank headline before the round trip", async () => {
		const { user } = renderEditor();
		await user.clear(screen.getByLabelText("Headline"));
		await user.click(
			screen.getByRole("button", { name: /save promo template/i }),
		);
		expect(updatePromoTemplate).not.toHaveBeenCalled();
	});

	it("Reset puts the default back", async () => {
		const { user } = renderEditor();
		const headline = screen.getByLabelText("Headline");
		await user.clear(headline);
		await user.type(headline, "Something else");
		await user.click(screen.getByRole("button", { name: /reset to default/i }));
		await waitFor(() =>
			expect(resetPromoTemplate).toHaveBeenCalledWith({ data: CLUB }),
		);
		expect((headline as HTMLTextAreaElement).value).toBe(
			toEditorText(DEFAULT_PROMO_TEMPLATE.headline),
		);
	});
});

// protects=the editor's save/discard/context wiring around the new fields;
// fails_when=a pill saves as its friendly name, Discard shows on a clean load
// or does not restore, or a failed context fetch breaks editing;
// no_claim=the menu's own behaviour (template-field.test.tsx) or real layout.
describe("PromoTemplateEditor wiring (#1536)", () => {
	const discard = () =>
		screen.queryByRole("button", { name: "Discard changes" });

	it("shows no Discard on a clean load, and none for a stored {DATE} or {Date}", () => {
		renderEditor();
		expect(discard()).toBeNull();
		cleanup();
		renderEditor({
			...DEFAULT_PROMO_TEMPLATE,
			headline: "Join {DATE} and {Date}",
		});
		expect(discard()).toBeNull();
		// {DATE} stays as typed and is flagged, with a Fix.
		expect(screen.getByText(/Did you mean Date\?/)).toBeTruthy();
	});

	it("Discard appears after a toggle, restores every field and the toggle without a server call", async () => {
		const { user } = renderEditor();
		const headline = screen.getByLabelText("Headline") as HTMLTextAreaElement;
		await user.type(headline, " more");
		await user.click(screen.getByLabelText("Why join in WhatsApp"));
		await user.click(screen.getByRole("button", { name: "Discard changes" }));
		expect(headline.value).toBe("You're invited: {Club name}, {Date}");
		expect(
			(screen.getByLabelText("Why join in WhatsApp") as HTMLInputElement)
				.checked,
		).toBe(true);
		expect(discard()).toBeNull();
		expect(updatePromoTemplate).not.toHaveBeenCalled();
	});

	it("a single toggle alone opens Discard", async () => {
		const { user } = renderEditor();
		await user.click(screen.getByLabelText("Why join in WhatsApp"));
		expect(discard()).not.toBeNull();
	});

	it("Save stores the key form of a picked pill, and Discard is gone right after", async () => {
		const { user } = renderEditor();
		const headline = screen.getByLabelText("Headline");
		await user.clear(headline);
		await user.type(headline, "  Hi @Date");
		await user.keyboard("{Enter}");
		expect((headline as HTMLTextAreaElement).value).toBe("  Hi {Date}");
		expect(discard()).not.toBeNull();
		await user.click(
			screen.getByRole("button", { name: /save promo template/i }),
		);
		await waitFor(() => expect(updatePromoTemplate).toHaveBeenCalledTimes(1));
		const sent = vi.mocked(updatePromoTemplate).mock.calls[0]?.[0] as {
			data: { template: typeof DEFAULT_PROMO_TEMPLATE };
		};
		expect(sent.data.template.headline).toBe("Hi {date}");
		await waitFor(() => expect(discard()).toBeNull());
	});

	it("reads the club context once and shows the meeting's values; a rejected call leaves editing intact", async () => {
		vi.mocked(getPromoContext).mockResolvedValue({
			club: { id: CLUB, name: "Acme TM", slug: "acme", timezone: "UTC" },
			template: DEFAULT_PROMO_TEMPLATE,
			logoUrl: null,
			meetings: [],
			selectedId: null,
		} as never);
		const { user } = renderEditor();
		await waitFor(() => expect(getPromoContext).toHaveBeenCalledTimes(1));
		expect(getPromoContext).toHaveBeenCalledWith({ data: { clubId: CLUB } });
		await user.click(
			screen.getAllByRole("button", { name: "Insert variable" })[0],
		);
		expect(
			(await screen.findByRole("option", { name: /Club name/ })).textContent,
		).toContain("Acme TM");
		cleanup();

		vi.mocked(getPromoContext).mockRejectedValue(new Error("nope"));
		const second = renderEditor();
		await waitFor(() => expect(getPromoContext).toHaveBeenCalledTimes(2));
		const headline = screen.getByLabelText("Headline") as HTMLTextAreaElement;
		await second.user.type(headline, "!");
		expect(headline.value.endsWith("!")).toBe(true);
	});
});

describe("a stored template that no longer parses", () => {
	it("is flagged, not silently replaced by the default", () => {
		render(
			<PromoTemplateEditor
				clubId={CLUB}
				template={DEFAULT_PROMO_TEMPLATE}
				storedInvalid
				onSaved={vi.fn()}
			/>,
		);
		expect(screen.getByTestId("promo-template-invalid").textContent).toMatch(
			/couldn't be read/,
		);
	});

	it("shows nothing when the template is fine (control)", () => {
		renderEditor();
		expect(screen.queryByTestId("promo-template-invalid")).toBeNull();
	});
});

describe("bulletsFromText", () => {
	it("trims and drops blank lines", () => {
		expect(bulletsFromText(" a \n\n b\r\n")).toEqual(["a", "b"]);
	});
});

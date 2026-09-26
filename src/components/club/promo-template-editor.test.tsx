// @vitest-environment jsdom
//
// The club's blast template editor (#931): what Save sends, the per-channel
// toggles, the unknown-placeholder warning, and Reset.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/promo", () => ({
	updatePromoTemplate: vi.fn(async () => ({ ok: true })),
	resetPromoTemplate: vi.fn(async () => ({ ok: true })),
	getPromoContext: vi.fn(),
}));

import { DEFAULT_PROMO_TEMPLATE } from "#/lib/promo-template";
import { resetPromoTemplate, updatePromoTemplate } from "#/server/promo";
import { bulletsFromText, PromoTemplateEditor } from "./promo-template-editor";

const CLUB = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
	cleanup();
	vi.mocked(updatePromoTemplate).mockClear();
	vi.mocked(resetPromoTemplate).mockClear();
});

function renderEditor() {
	const onSaved = vi.fn(async () => {});
	render(
		<PromoTemplateEditor
			clubId={CLUB}
			template={DEFAULT_PROMO_TEMPLATE}
			onSaved={onSaved}
		/>,
	);
	return { user: userEvent.setup(), onSaved };
}

describe("PromoTemplateEditor", () => {
	it("a new club's editor shows the seeded default", () => {
		renderEditor();
		expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe(
			DEFAULT_PROMO_TEMPLATE.headline,
		);
		expect(
			(screen.getByLabelText("Why join (one per line)") as HTMLTextAreaElement)
				.value,
		).toBe(DEFAULT_PROMO_TEMPLATE.whyJoin.join("\n"));
	});

	it("Save sends the edited template, bullets one per line and toggles applied", async () => {
		const { user, onSaved } = renderEditor();
		const headline = screen.getByLabelText("Headline");
		await user.clear(headline);
		await user.type(headline, "Come to {{club}");
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

	it("warns about an unknown placeholder while typing", async () => {
		const { user } = renderEditor();
		expect(screen.queryByRole("alert")).toBeNull();
		await user.type(screen.getByLabelText("Call to action"), " {{rsvp}");
		expect(screen.getByRole("alert").textContent).toContain("{rsvp}");
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
		expect((headline as HTMLInputElement).value).toBe(
			DEFAULT_PROMO_TEMPLATE.headline,
		);
	});
});

describe("bulletsFromText", () => {
	it("trims and drops blank lines", () => {
		expect(bulletsFromText(" a \n\n b\r\n")).toEqual(["a", "b"]);
	});
});

// @vitest-environment jsdom
//
// The Promote action on the meeting toolbar (#931): admin only. A member (or
// a guest) never sees it; an admin sees it and it opens the sheet for THIS
// meeting's database id.
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/packet", () => ({ getPacketContext: vi.fn() }));
vi.mock("#/server/promo", () => ({
	getPromoContext: vi.fn(async () => ({
		club: {
			id: "c1",
			name: "Downtown Speakers",
			slug: "downtown",
			timezone: "America/Chicago",
		},
		template: (await import("#/lib/promo-template")).DEFAULT_PROMO_TEMPLATE,
		logoUrl: null,
		meetings: [
			{
				id: "11111111-2222-4333-8444-555555555555",
				urlKey: "2026-08-10",
				scheduledAt: "2026-08-10T23:45:00Z",
				location: "Room 4",
				online: false,
				theme: "Beginnings",
				wordOfTheDay: null,
				meetingNumber: 12,
				promoNote: null,
			},
		],
		selectedId: "11111111-2222-4333-8444-555555555555",
	})),
}));

import type { MeetingPhase } from "#/lib/meeting-lifecycle";
import { getPromoContext } from "#/server/promo";
import { renderUnderMemoryRouter } from "#/test/router-harness";
import { MeetingToolbar } from "./meeting-toolbar";

const DB_ID = "11111111-2222-4333-8444-555555555555";

const props = (canManage: boolean) => ({
	phase: "upcoming" as MeetingPhase,
	clubSlug: "downtown",
	meetingId: "2026-08-10",
	dbMeetingId: DB_ID,
	sharePath: "/club/downtown/meeting/2026-08-10",
	wordOfTheDay: null,
	hasIdentity: true,
	canManage,
	locked: false,
	canComplete: false,
	hasAddableRoles: false,
	lifecycleBusy: false,
	onAddRole: vi.fn(),
	onComplete: vi.fn(),
	onReopen: vi.fn(),
});

afterEach(() => {
	cleanup();
	vi.mocked(getPromoContext).mockClear();
});

describe("Promote on the meeting toolbar (#931)", () => {
	it("a member does not see it", async () => {
		await renderUnderMemoryRouter(<MeetingToolbar {...props(false)} />);
		expect(screen.queryByRole("button", { name: /promote/i })).toBeNull();
	});

	it("an admin sees it, and it opens the sheet for this meeting", async () => {
		await renderUnderMemoryRouter(<MeetingToolbar {...props(true)} />);
		await userEvent.click(screen.getByRole("button", { name: /promote/i }));
		await waitFor(() =>
			expect(getPromoContext).toHaveBeenCalledWith({
				data: { meetingId: DB_ID },
			}),
		);
		// The drafted WhatsApp message is on screen, headline first.
		const draft = (await screen.findByLabelText(
			"WhatsApp message",
		)) as HTMLTextAreaElement;
		expect(draft.value).toMatch(/^\*You're invited: Downtown Speakers/);
		expect(draft.value).toContain("/club/downtown/meeting/2026-08-10");
	});
});

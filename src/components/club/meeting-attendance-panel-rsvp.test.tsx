// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// Same stubs as the panel's main suite: its guest dialog imports server fns.
vi.mock("#/server/guest-pipeline", () => ({ updateGuest: vi.fn() }));
vi.mock("#/server/guests", () => ({
	getGuestProfile: vi.fn().mockResolvedValue(null),
	updateGuestProfile: vi.fn(),
}));

import { MeetingAttendancePanel } from "./meeting-attendance-panel";

const RSVP_URL = "https://club.example/club/c/meeting/k/rsvp";
const roster = [
	{
		id: "m1",
		name: "Ayesha Khan",
		preferredName: null,
		phone: "+15551234567",
		email: null,
	},
	{
		id: "m2",
		name: "Bo Lin",
		preferredName: null,
		phone: "+15550001111",
		email: null,
	},
	{
		id: "m3",
		name: "Cy Ode",
		preferredName: null,
		phone: "+15550002222",
		email: null,
	},
];

afterEach(cleanup);

function renderPanel(
	over: Partial<Parameters<typeof MeetingAttendancePanel>[0]> = {},
) {
	return render(
		<MeetingAttendancePanel
			mode="plan"
			roster={roster}
			plan={[]}
			rungOverride={{}}
			roleByMemberId={{}}
			meetingDate="Tue 19 Aug"
			shareUrl="https://club.example/agenda"
			rsvpUrl={RSVP_URL}
			rsvpWeekday="Tuesday"
			clubName="Test Club"
			locked={false}
			canClearRung
			onWriteRung={vi.fn()}
			onContacted={vi.fn()}
			{...over}
		/>,
	);
}

async function whatsappDraft(name: string): Promise<string> {
	const user = userEvent.setup();
	await user.click(screen.getByRole("button", { name: `Contact ${name}` }));
	const item = within(screen.getByRole("menu")).getByRole("menuitem", {
		name: /^WhatsApp/,
	});
	const href = item.getAttribute("href") ?? "";
	await user.keyboard("{Escape}");
	return decodeURIComponent(href);
}

describe("still-to-answer rows draft the RSVP ask (#1442 AC 4)", () => {
	it("offers the rsvp draft, carrying the RSVP URL, on every still-to-answer row", async () => {
		renderPanel({
			plan: [
				{ memberId: "m2", status: "reached_out" as const },
				{ memberId: "m3", status: "coming" as const },
			],
		});
		// m1 has no answer, m2 was asked and has not replied: both are owed one.
		for (const name of ["Ayesha Khan", "Bo Lin"]) {
			const draft = await whatsappDraft(name);
			expect(draft).toContain("coming to Test Club on Tuesday?");
			expect(draft).toContain(RSVP_URL);
			expect(draft).not.toContain("https://club.example/agenda");
		}
	});

	it("a role holder who has not answered gets the rsvp draft, not the confirm one", async () => {
		renderPanel({
			roleByMemberId: {
				m1: { code: "TD", roleName: "Toastmaster", confirmed: false },
			},
		});
		const draft = await whatsappDraft("Ayesha Khan");
		expect(draft).toContain(RSVP_URL);
		expect(draft).not.toContain("just confirming");
	});

	it("does not offer the rsvp draft to someone who has already answered", async () => {
		renderPanel({ plan: [{ memberId: "m1", status: "not_coming" as const }] });
		const draft = await whatsappDraft("Ayesha Khan");
		expect(draft).not.toContain(RSVP_URL);
	});
});

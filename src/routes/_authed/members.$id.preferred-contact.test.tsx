// @vitest-environment jsdom
//
// The member page and a member's preferred contact method (#1093): the contact
// row leads with the EFFECTIVE preference's link and a "Preferred" badge, a
// `tel:`/`sms:` link exists only while that method is the effective preference,
// and the edit dialog sends the field only when it changed and never for a
// member who has signed in.
//
// Same harness as `members.$id.test.tsx`: server-fn modules mocked, loader data
// stubbed, the route component rendered under the memory router.
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editMember } from "#/server/members";
import { renderUnderMemoryRouter } from "#/test/router-harness";

vi.mock("#/server/club", () => ({ getMemberProfile: vi.fn() }));
vi.mock("#/server/members", () => ({
	editMember: vi.fn(),
	removeMember: vi.fn(),
	setMemberRole: vi.fn(),
	setMemberStatus: vi.fn(),
}));
vi.mock("#/server/path-enrollment", () => ({
	addMemberPath: vi.fn(),
	getMemberEnrollments: vi.fn(),
	listPathwayOptions: vi.fn(),
	removeMemberPath: vi.fn(),
}));
vi.mock("#/server/mentorship", () => ({
	createMentorship: vi.fn(),
	endMentorship: vi.fn(),
	getMemberMentorships: vi.fn(),
	setMentorshipFocus: vi.fn(),
}));
vi.mock("#/server/orientation", () => ({
	getMemberOrientation: vi.fn(),
	startOrientation: vi.fn(),
}));
vi.mock("#/server/pathways-read", () => ({ getMemberPathways: vi.fn() }));
vi.mock("#/server/progress-marks", () => ({
	markMemberProject: vi.fn(),
	unmarkMemberProject: vi.fn(),
}));
vi.mock("#/server/speeches", () => ({
	archiveSpeech: vi.fn(),
	rescheduleSpeech: vi.fn(),
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { Route } from "./members.$id";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

const CLUB_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

function profileMember(over: Record<string, unknown> = {}) {
	return {
		id: MEMBER_ID,
		name: "Ada Member",
		preferredName: null,
		phone: "+14155552671",
		phoneRaw: "+14155552671",
		email: "ada@example.com",
		preferredContact: null,
		contactPreferenceRefusal: null,
		officerPositions: [] as string[],
		userId: null,
		status: "active" as const,
		clubRole: "member" as const,
		createdAt: new Date("2024-01-15T00:00:00Z"),
		joinedAt: new Date("2024-01-15T00:00:00Z"),
		originalJoinDate: null,
		...over,
	};
}

async function renderRoute(
	over: Record<string, unknown> = {},
	clubRole: "admin" | "member" = "member",
) {
	vi.spyOn(Route, "useRouteContext").mockReturnValue({
		clubs: [{ clubId: CLUB_ID, name: "Club", clubNumber: "1", clubRole }],
		activeClubId: CLUB_ID,
		officerPositions: [],
		impersonating: null,
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	vi.spyOn(Route, "useLoaderData").mockReturnValue({
		member: profileMember(over),
		speechLog: [],
		rolesServed: [],
		speeches: 0,
		pathways: [],
		unscheduledSpeeches: [],
		openSpeakerSlots: [],
		pathOptions: [],
		enrollments: [],
		speechLogTruncated: false,
		allSpeeches: false,
		now: Date.parse("2026-09-24T12:00:00Z"),
		timezone: "UTC",
		// biome-ignore lint/suspicious/noExplicitAny: stubbed hook return
	} as any);
	const Component = Route.options.component as () => React.ReactElement;
	await renderUnderMemoryRouter(<Component />);
}

function contactLinks(): HTMLAnchorElement[] {
	const heading = screen.getByRole("heading", { level: 1, name: "Ada Member" });
	const column = heading.parentElement as HTMLElement;
	return within(column).queryAllByRole("link") as HTMLAnchorElement[];
}

describe("member page contact row (#1093)", () => {
	it("with no preference: email then WhatsApp, no badge, no tel/sms", async () => {
		await renderRoute();
		const hrefs = contactLinks().map((a) => a.getAttribute("href") ?? "");
		expect(hrefs[0]).toMatch(/^mailto:/);
		expect(hrefs[1]).toContain("whatsapp");
		expect(hrefs.some((h) => /^(tel|sms):/.test(h))).toBe(false);
		expect(screen.queryByText("Preferred")).toBeNull();
	});

	it("leads with an sms: link and the badge when SMS is preferred", async () => {
		await renderRoute({ preferredContact: "sms" });
		const hrefs = contactLinks().map((a) => a.getAttribute("href") ?? "");
		expect(hrefs[0]).toBe("sms:+14155552671");
		expect(hrefs[1]).toMatch(/^mailto:/);
		expect(hrefs[2]).toContain("whatsapp");
		expect(hrefs.some((h) => h.startsWith("tel:"))).toBe(false);
		const badge = screen.getByText("Preferred");
		expect(
			within(screen.getByTestId("preferred-contact")).getByRole("link"),
		).toBeTruthy();
		expect(badge.closest("[data-testid=preferred-contact]")).toBeTruthy();
	});

	it("leads with a tel: link when Call is preferred", async () => {
		await renderRoute({ preferredContact: "call" });
		const hrefs = contactLinks().map((a) => a.getAttribute("href") ?? "");
		expect(hrefs[0]).toBe("tel:+14155552671");
		expect(hrefs.some((h) => h.startsWith("sms:"))).toBe(false);
	});

	it("moves WhatsApp first, once, when it is preferred", async () => {
		await renderRoute({ preferredContact: "whatsapp" });
		const hrefs = contactLinks().map((a) => a.getAttribute("href") ?? "");
		expect(hrefs).toHaveLength(2);
		expect(hrefs[0]).toContain("whatsapp");
		expect(hrefs[1]).toMatch(/^mailto:/);
	});

	it("moves email first, once, when it is preferred", async () => {
		await renderRoute({ preferredContact: "email" });
		const hrefs = contactLinks().map((a) => a.getAttribute("href") ?? "");
		expect(hrefs).toHaveLength(2);
		expect(hrefs[0]).toMatch(/^mailto:/);
		expect(hrefs[1]).toContain("whatsapp");
	});
});

describe("member edit dialog: preferred contact (#1093)", () => {
	async function openEdit(over: Record<string, unknown>) {
		vi.mocked(editMember).mockResolvedValue({
			ok: true,
			rosterConflict: null,
			emailRefused: null,
		});
		await renderRoute(over, "admin");
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
	}

	it("offers only the methods the saved data supports", async () => {
		await openEdit({ phone: null, phoneRaw: null });
		const select = screen.getByLabelText("Preferred contact");
		const values = Array.from((select as HTMLSelectElement).options).map(
			(o) => o.value,
		);
		expect(values).toEqual(["", "email"]);
	});

	it("sends the field only when it changed", async () => {
		await openEdit({ preferredContact: "sms" });
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await vi.waitFor(() => expect(editMember).toHaveBeenCalled());
		expect(vi.mocked(editMember).mock.calls[0]?.[0]?.data).not.toHaveProperty(
			"preferredContact",
		);
	});

	it("sends a changed value", async () => {
		await openEdit({ preferredContact: "sms" });
		fireEvent.change(screen.getByLabelText("Preferred contact"), {
			target: { value: "call" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await vi.waitFor(() => expect(editMember).toHaveBeenCalled());
		expect(vi.mocked(editMember).mock.calls[0]?.[0]?.data).toMatchObject({
			preferredContact: "call",
		});
	});

	it("shows a signed-in member's choice read-only and never sends it, when the member chose it", async () => {
		await openEdit({
			userId: "u1",
			preferredContact: "sms",
			contactPreferenceRefusal: "member_set",
		});
		const field = screen.getByLabelText(
			"Preferred contact",
		) as HTMLInputElement;
		expect(field.readOnly).toBe(true);
		expect(field.value).toBe("SMS");
		expect(screen.getByText("The member chose this themselves.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await vi.waitFor(() => expect(editMember).toHaveBeenCalled());
		expect(vi.mocked(editMember).mock.calls[0]?.[0]?.data).not.toHaveProperty(
			"preferredContact",
		);
	});

	it("shows the select for a signed-in member who never chose (AC8)", async () => {
		await openEdit({
			userId: "u1",
			preferredContact: null,
			contactPreferenceRefusal: null,
		});
		const field = screen.getByLabelText("Preferred contact");
		expect(field.tagName).toBe("SELECT");
		fireEvent.change(field, { target: { value: "call" } });
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await vi.waitFor(() => expect(editMember).toHaveBeenCalled());
		expect(vi.mocked(editMember).mock.calls[0]?.[0]?.data).toMatchObject({
			preferredContact: "call",
		});
	});

	// Wiring guard (AC12): the lock follows `contactPreferenceRefusal`, not
	// `userId`. Swapping the prop that feeds it flips one of these two.
	it("locks on the refusal even when nobody has signed in", async () => {
		await openEdit({
			userId: null,
			preferredContact: "sms",
			contactPreferenceRefusal: "member_set",
		});
		expect(
			(screen.getByLabelText("Preferred contact") as HTMLInputElement).readOnly,
		).toBe(true);
	});

	it("locks the field for a Person another club also holds, and never sends it", async () => {
		await openEdit({
			preferredContact: "email",
			contactPreferenceRefusal: "multi_club",
		});
		const field = screen.getByLabelText(
			"Preferred contact",
		) as HTMLInputElement;
		expect(field.readOnly).toBe(true);
		expect(field.value).toBe("Email");
		expect(
			screen.getByText(/Another club also has them on its roster/),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
		await vi.waitFor(() => expect(editMember).toHaveBeenCalled());
		expect(vi.mocked(editMember).mock.calls[0]?.[0]?.data).not.toHaveProperty(
			"preferredContact",
		);
	});
});

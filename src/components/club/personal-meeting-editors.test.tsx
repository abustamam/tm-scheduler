// @vitest-environment jsdom
//
// Render tests for the two focused duty editors (#666).
//
// These exist because the route files that mount them cannot be imported by
// vitest at all — `#/server/meetings` → `#/db` → "DATABASE_URL is not set" — so
// every branch below would otherwise be reachable by a source grep and nothing
// else. `personal-meeting-body.test.tsx` next door is the precedent, and
// supplies both patterns used here: `vi.mock` of the write seams, and the
// memory-router harness a `<Link>` needs.
//
// ## The two cases worth reading first
//
// 1. **A theme save must not erase the rest of the meeting.** `updateMeeting`
//    is a full REPLACE, so the payload assertion below is not thoroughness — it
//    is the whole reason `themeOnlyUpdate` exists. Drop the echo and this file
//    fails; ship without it and a Toastmaster setting a theme silently clears
//    the club's location, Word of the Day, announcements and notes.
// 2. **A key-NULL look-alike role is denied (#464).** "Toastmaster Assistant"
//    and "Grammarian Assistant" are exactly what `createClubRole` produces —
//    every club-invented role carries a NULL key — and both must be refused the
//    form, the same way `resolveMeetingAgendaAuthz` refuses them the write.
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/server/meetings", () => ({
	updateMeeting: vi.fn(async () => ({ clubId: "c1" })),
	updateWordOfTheDay: vi.fn(async () => ({ clubId: "c1" })),
}));

const { updateMeeting, updateWordOfTheDay } = await import("#/server/meetings");
const { renderUnderMemoryRouter } = await import("#/test/router-harness");
const { PersonalThemeEditor, PersonalWordEditor } = await import(
	"./personal-meeting-editors"
);

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const MEMBER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

/** The stored meta a theme-only save must carry back untouched. Each value is
 *  distinct so a payload that crosses two fields fails. */
const STORED = {
	id: "22222222-2222-4222-8222-222222222222",
	// Comfortably in the future, so `isMeetingOver`'s day check is false whenever
	// this suite runs — no wall-clock time bomb.
	scheduledAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
	status: "scheduled",
	theme: "Old theme",
	location: "The Old Library, Room 5",
	wordOfTheDay: "ineffable",
	wodDefinition: "too great to be expressed in words",
	wodExample: "an ineffable joy",
	notes: "Bring the spare timing lights",
	reminders: "Contest entries close Friday",
};

const slot = (
	roleName: string,
	roleKey: string | null,
	assigneeId: string,
) => ({
	roleName,
	roleKey,
	assigneeId,
});

const TMOD_SLOT = slot(
	"Toastmaster of the Day",
	"toastmaster_of_the_day",
	MEMBER,
);
const GRAMMARIAN_SLOT = slot("Grammarian", "grammarian", MEMBER);

type Props = Parameters<typeof PersonalThemeEditor>[0];

function props(over: Partial<Props> = {}): Props {
	return {
		clubId: "harbor-city",
		meetingId: "2026-09-15",
		meeting: { ...STORED },
		slots: [TMOD_SLOT],
		timezone: "America/Chicago",
		canManage: false,
		memberId: MEMBER,
		isSignedIn: false,
		onSaved: vi.fn(async () => {}),
		...over,
	};
}

const renderTheme = (over: Partial<Props> = {}) => {
	const p = props(over);
	return renderUnderMemoryRouter(<PersonalThemeEditor {...p} />).then(() => p);
};
const renderWord = (over: Partial<Props> = {}) => {
	const p = props({ slots: [GRAMMARIAN_SLOT], ...over });
	return renderUnderMemoryRouter(<PersonalWordEditor {...p} />).then(() => p);
};

/**
 * The payload each assertion reads. Throws rather than optional-chaining to
 * `undefined`: a payload assertion against a writer that was never called is
 * the vacuous pass this whole file exists to avoid.
 */
function payloadOf(mock: { mock: { calls: unknown[][] } }, name: string) {
	const call = mock.mock.calls[0];
	if (!call) throw new Error(`${name} was never called`);
	return (call[0] as { data: Record<string, unknown> }).data;
}
const themePayload = () => payloadOf(vi.mocked(updateMeeting), "updateMeeting");
const wordPayload = () =>
	payloadOf(vi.mocked(updateWordOfTheDay), "updateWordOfTheDay");

describe("PersonalThemeEditor — who is offered the form", () => {
	it("offers it to the meeting's self-asserted Toastmaster", async () => {
		await renderTheme();
		expect(screen.getByLabelText("Theme")).toBeTruthy();
		expect(screen.getByRole("button", { name: /save theme/i })).toBeTruthy();
	});

	it("offers it to a club officer who does not hold the TMOD slot", async () => {
		// The admin arm. `resolveMeetingAgendaAuthz` grants it, so telling them
		// otherwise would be a false denial on a capability they really have.
		await renderTheme({
			slots: [slot(TMOD_SLOT.roleName, TMOD_SLOT.roleKey, OTHER)],
			canManage: true,
			isSignedIn: true,
		});
		expect(screen.getByLabelText("Theme")).toBeTruthy();
	});

	it("refuses the meeting's Grammarian", async () => {
		await renderTheme({ slots: [GRAMMARIAN_SLOT] });
		expect(screen.queryByLabelText("Theme")).toBeNull();
		expect(screen.getByText(/only this meeting's toastmaster/i)).toBeTruthy();
	});

	it("refuses a member holding no relevant role", async () => {
		await renderTheme({
			slots: [
				slot("Timer", "timer", MEMBER),
				slot(TMOD_SLOT.roleName, TMOD_SLOT.roleKey, OTHER),
			],
		});
		expect(screen.queryByLabelText("Theme")).toBeNull();
	});

	// #464. Every club-invented role carries a NULL key, and the name fallback
	// matches the canonical name EXACTLY — never as a prefix.
	it("refuses a club-invented role whose NAME merely looks like the TMOD", async () => {
		await renderTheme({ slots: [slot("Toastmaster Assistant", null, MEMBER)] });
		expect(screen.queryByLabelText("Theme")).toBeNull();
		expect(screen.getByText(/only this meeting's toastmaster/i)).toBeTruthy();
	});

	it("still recognises the TMOD after the club RENAMES the role", async () => {
		// The key is the identity; the name is a label.
		await renderTheme({
			slots: [slot("MC", "toastmaster_of_the_day", MEMBER)],
		});
		expect(screen.getByLabelText("Theme")).toBeTruthy();
	});

	it("closes on a completed meeting, and says so instead of blaming the role", async () => {
		await renderTheme({ meeting: { ...STORED, status: "completed" } });
		expect(screen.queryByLabelText("Theme")).toBeNull();
		expect(screen.getByText(/this meeting is finished/i)).toBeTruthy();
		expect(screen.queryByText(/only this meeting's toastmaster/i)).toBeNull();
	});

	it("closes on a cancelled meeting even though its date is still ahead", async () => {
		await renderTheme({ meeting: { ...STORED, status: "cancelled" } });
		expect(screen.queryByLabelText("Theme")).toBeNull();
		expect(screen.getByText(/cancelled/i)).toBeTruthy();
	});

	it("always offers the way back, blocked or not", async () => {
		await renderTheme({ meeting: { ...STORED, status: "completed" } });
		const back = screen.getByRole("link", {
			name: /back to your meeting page/i,
		});
		expect(back.getAttribute("href")).toBe(
			"/club/harbor-city/meeting/2026-09-15/me",
		);
	});
});

describe("PersonalThemeEditor — the save", () => {
	it("prefills the stored theme", async () => {
		await renderTheme();
		expect((screen.getByLabelText("Theme") as HTMLInputElement).value).toBe(
			"Old theme",
		);
	});

	it("sends the new theme AND echoes every other stored field", async () => {
		const p = await renderTheme();
		const input = screen.getByLabelText("Theme");
		await userEvent.clear(input);
		await userEvent.type(input, "New beginnings");
		await userEvent.click(screen.getByRole("button", { name: /save theme/i }));

		await waitFor(() => expect(updateMeeting).toHaveBeenCalledTimes(1));
		const data = themePayload();
		expect(data.theme).toBe("New beginnings");
		// `updateMeeting` NULLS every field it is not given. Without these six the
		// club loses all of it on one tap, with the write reporting success.
		expect(data.location).toBe(STORED.location);
		expect(data.wordOfTheDay).toBe(STORED.wordOfTheDay);
		expect(data.wodDefinition).toBe(STORED.wodDefinition);
		expect(data.wodExample).toBe(STORED.wodExample);
		expect(data.notes).toBe(STORED.notes);
		expect(data.reminders).toBe(STORED.reminders);
		expect(p.onSaved).toHaveBeenCalledTimes(1);
	});

	it("writes against the RESOLVED meeting uuid, never the URL segment", async () => {
		await renderTheme();
		await userEvent.click(screen.getByRole("button", { name: /save theme/i }));
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		// The segment is a club-local date key and the writer validates a uuid, so
		// passing it would reject the save after the page rendered fine.
		expect(themePayload().meetingId).toBe(STORED.id);
	});

	it("resubmits the meeting's current wall time, so it reads as a no-op", async () => {
		await renderTheme();
		await userEvent.click(screen.getByRole("button", { name: /save theme/i }));
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		// `applyMeetingUpdate` compares to the MINUTE for a caller who may not
		// reschedule, so this has to be the wall time in the club's zone.
		const { utcToZonedWallTime } = await import("#/lib/datetime");
		expect(themePayload().scheduledAt).toBe(
			utcToZonedWallTime(STORED.scheduledAt, "America/Chicago"),
		);
	});

	it("self-asserts the member id for an anonymous caller", async () => {
		await renderTheme();
		await userEvent.click(screen.getByRole("button", { name: /save theme/i }));
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect(themePayload().selfMemberId).toBe(MEMBER);
	});

	it("STILL self-asserts for a signed-in caller — the session is not a grant", async () => {
		// This case previously asserted `toBeNull()`, and that was the bug rather
		// than the contract. `isSignedIn` comes from `publicShellDecision`, which
		// returns `shell: true` for ANY member of the club — not just an admin. So
		// nulling on it broke the exact person this feature is for: an ordinary
		// signed-in member holding this meeting's TMOD slot got the form rendered
		// (`runsMeeting` includes `isTmod`) and a permission error on Save.
		//
		// Sending it is not the forgeable input #396 removed, because nothing
		// trusts it: `resolveMeetingAgendaAuthz` runs the admin arm first without
		// reading it, and the self-assert arm verifies it against
		// `role_slots.assigned_member_id` before crediting it.
		await renderTheme({ isSignedIn: true });
		await userEvent.click(screen.getByRole("button", { name: /save theme/i }));
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect(themePayload().selfMemberId).toBe(MEMBER);
	});

	it("does NOT hand back to the personal page when the write fails", async () => {
		// The tick is the receipt: returning after a failed save would show a
		// checklist that has not moved, with the error toast already gone.
		vi.mocked(updateMeeting).mockRejectedValueOnce(new Error("nope"));
		const p = await renderTheme();
		await userEvent.click(screen.getByRole("button", { name: /save theme/i }));
		await waitFor(() => expect(updateMeeting).toHaveBeenCalled());
		expect(p.onSaved).not.toHaveBeenCalled();
	});
});

describe("PersonalWordEditor — who is offered the form", () => {
	it("offers it to the meeting's self-asserted Grammarian", async () => {
		await renderWord();
		expect(screen.getByLabelText("Word")).toBeTruthy();
	});

	it("offers it to the meeting's Toastmaster too", async () => {
		// `resolveWordOfTheDayAuthz` has three grant arms, and `canEditWod` alone
		// is the pure Grammarian's — reading it on its own denies the TMOD.
		await renderWord({ slots: [TMOD_SLOT] });
		expect(screen.getByLabelText("Word")).toBeTruthy();
	});

	it("offers it to a club officer holding neither slot", async () => {
		await renderWord({
			slots: [slot("Grammarian", "grammarian", OTHER)],
			canManage: true,
			isSignedIn: true,
		});
		expect(screen.getByLabelText("Word")).toBeTruthy();
	});

	it("refuses a member holding no relevant role", async () => {
		await renderWord({
			slots: [
				slot("Timer", "timer", MEMBER),
				slot("Grammarian", "grammarian", OTHER),
			],
		});
		expect(screen.queryByLabelText("Word")).toBeNull();
		expect(screen.getByText(/only this meeting's grammarian/i)).toBeTruthy();
	});

	it("refuses a club-invented role whose NAME merely looks like the Grammarian", async () => {
		await renderWord({ slots: [slot("Grammarian Assistant", null, MEMBER)] });
		expect(screen.queryByLabelText("Word")).toBeNull();
	});

	it("closes on a completed meeting", async () => {
		await renderWord({ meeting: { ...STORED, status: "completed" } });
		expect(screen.queryByLabelText("Word")).toBeNull();
		expect(screen.getByText(/this meeting is finished/i)).toBeTruthy();
	});
});

describe("PersonalWordEditor — the save", () => {
	it("prefills all three stored fields", async () => {
		await renderWord();
		expect((screen.getByLabelText("Word") as HTMLInputElement).value).toBe(
			STORED.wordOfTheDay,
		);
		expect(
			(screen.getByLabelText("Definition") as HTMLTextAreaElement).value,
		).toBe(STORED.wodDefinition);
		expect(
			(screen.getByLabelText("Example sentence") as HTMLTextAreaElement).value,
		).toBe(STORED.wodExample);
	});

	it("carries the untouched definition and example back with a changed word", async () => {
		// `applyWordOfTheDayUpdate` nulls what it is not given, so a word-only
		// payload clears the definition the Grammarian never touched.
		const p = await renderWord();
		const word = screen.getByLabelText("Word");
		await userEvent.clear(word);
		await userEvent.type(word, "loquacious");
		await userEvent.click(
			screen.getByRole("button", { name: /save word of the day/i }),
		);

		await waitFor(() => expect(updateWordOfTheDay).toHaveBeenCalledTimes(1));
		const data = wordPayload();
		expect(data.wordOfTheDay).toBe("loquacious");
		expect(data.wodDefinition).toBe(STORED.wodDefinition);
		expect(data.wodExample).toBe(STORED.wodExample);
		expect(data.meetingId).toBe(STORED.id);
		expect(data.selfMemberId).toBe(MEMBER);
		expect(p.onSaved).toHaveBeenCalledTimes(1);
	});

	it("sends a cleared field as undefined, which the writer stores as null", async () => {
		await renderWord();
		await userEvent.clear(screen.getByLabelText("Example sentence"));
		await userEvent.click(
			screen.getByRole("button", { name: /save word of the day/i }),
		);
		await waitFor(() => expect(updateWordOfTheDay).toHaveBeenCalled());
		expect(wordPayload().wodExample).toBeUndefined();
	});

	it("does NOT hand back to the personal page when the write fails", async () => {
		vi.mocked(updateWordOfTheDay).mockRejectedValueOnce(new Error("nope"));
		const p = await renderWord();
		await userEvent.click(
			screen.getByRole("button", { name: /save word of the day/i }),
		);
		await waitFor(() => expect(updateWordOfTheDay).toHaveBeenCalled());
		expect(p.onSaved).not.toHaveBeenCalled();
	});
});

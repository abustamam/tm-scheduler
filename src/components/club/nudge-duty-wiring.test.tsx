// @vitest-environment jsdom
//
// The prop→draft wiring for duty-aware nudges (#667), on all four surfaces that
// send one.
//
// `nudge.test.ts` proves what `buildNudge` DOES with duties and a personal
// link; none of it can see whether a surface passes them. That gap is this
// repo's measured failure shape — "a component tested through its props cannot
// see a WRONG prop" (#319) — and it is wide here: every one of these props is
// OPTIONAL, so severing `duties={…}` or `personalUrl={…}` at any call site
// leaves the whole suite green and silently ships the pre-#667 draft. Each test
// below asserts on the RENDERED href, which is the only artifact the recipient
// ever sees.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
	type MeetingAgendaProps,
} from "#/components/agenda/meeting-agenda";
import { MeetingAttendancePanel } from "#/components/club/meeting-attendance-panel";
import { NudgeButtons } from "#/components/club/nudge-buttons";
import {
	NudgeRecruitPicker,
	type RecruitTarget,
} from "#/components/club/nudge-recruit-picker";
import { buildPanelRoleMap } from "#/lib/attendance-panel";
import { GRAMMARIAN_ROLE_KEY } from "#/lib/meeting-roles";
import { meetingViewer } from "#/lib/meeting-viewer";
import { outstandingDuties, type PersonalNudgeBase } from "#/lib/nudge";

// <MeetingAgenda> imports the assign/edit-speech sheets, which pull server-fn
// modules and their eager `#/db` import ("DATABASE_URL is not set" at import
// time under jsdom). No handler runs in a render-only test.
vi.mock("#/db", () => ({ db: {} }));

// cmdk (the recruit picker's list) measures on mount and scrolls the active
// item into view; jsdom has neither API. Same stub the picker's own suite uses.
class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver =
	ResizeObserverStub as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};

/** The Grammarian's one duty, un-done — the worked example throughout #667. */
const WORD_DUTY = outstandingDuties(
	{ roleName: "Grammarian", roleKey: GRAMMARIAN_ROLE_KEY },
	{ wordOfTheDay: null },
);

const PERSONAL: PersonalNudgeBase = {
	origin: "https://gavelup.app",
	clubId: "mcf",
	meetingKey: "2026-09-09",
};

const SHARE_URL = "https://gavelup.app/club/mcf/meeting/2026-09-09";

/** The draft body, read back out of whichever channel link is to hand — the
 *  `mailto:` body and the WhatsApp `text` are the same string. */
function draftText(link: Element): string {
	const href = link.getAttribute("href") ?? "";
	const params = new URL(href.replace(/^mailto:/, "https://x/")).searchParams;
	return decodeURIComponent(params.get("text") ?? params.get("body") ?? "");
}

const whatsapp = () => screen.getByRole("link", { name: /whatsapp/i });

describe("NudgeButtons carries duties and the personal link", () => {
	afterEach(() => cleanup());

	const base = {
		name: "Jane",
		roleName: "Grammarian",
		meetingDate: "Thu, Jul 23",
		shareUrl: SHARE_URL,
		phone: "14155552671",
		email: null,
	};

	it("puts the outstanding clause and the personal link in the draft", () => {
		render(
			<NudgeButtons
				{...base}
				mode="confirm"
				duties={WORD_DUTY}
				personalUrl="https://gavelup.app/club/mcf/meeting/2026-09-09/me?as=m1"
			/>,
		);
		const text = draftText(whatsapp());
		expect(text).toContain("you'll also need to set the Word of the Day");
		expect(text).toContain("/me?as=m1");
		// The public agenda is no longer what a ROLE draft links to.
		expect(text).not.toContain(`${SHARE_URL} `);
	});

	it("drafts exactly what it used to when the role owes nothing", () => {
		render(<NudgeButtons {...base} mode="confirm" duties={[]} />);
		const text = draftText(whatsapp());
		expect(text).toContain(`Details: ${SHARE_URL}`);
		expect(text).not.toContain("also need");
	});
});

describe("the recruit picker's draft", () => {
	afterEach(() => cleanup());

	const pick = async (over: Partial<RecruitTarget> = {}) => {
		const user = userEvent.setup();
		const target: RecruitTarget = {
			id: "m9",
			name: "Priya Raman",
			preferredName: null,
			phone: "14155552671",
			email: null,
			notAvailable: false,
			alreadyRole: null,
			contacted: false,
			...over,
		};
		render(
			<NudgeRecruitPicker
				roleName="Grammarian"
				duties={WORD_DUTY}
				meetingDate="Thu, Jul 23"
				shareUrl={SHARE_URL}
				personalNudgeBase={PERSONAL}
				targets={[target]}
			/>,
		);
		await user.click(screen.getByRole("button", { name: /nudge someone/i }));
		await user.click(await screen.findByText(target.name));
		return screen.findByRole("link", { name: /whatsapp/i });
	};

	it("names what the open role would owe, and links to the picked member's page", async () => {
		const text = draftText(await pick());
		expect(text).toContain("You'd also need to set the Word of the Day");
		// `?as=` is the PICKED member's, which is the whole reason the picker
		// takes a base rather than a finished URL.
		expect(text).toContain("/club/mcf/meeting/2026-09-09/me?as=m9");
	});
});

describe("the attendance rail's drafts", () => {
	afterEach(() => cleanup());

	const roster = [
		{
			id: "m1",
			name: "Jane Doe",
			preferredName: null,
			phone: "14155552671",
			email: null,
		},
		{
			id: "m2",
			name: "Sam Rivera",
			preferredName: null,
			phone: "14155552672",
			email: null,
		},
	];

	/** m1 holds the Grammarian slot; m2 holds nothing. */
	const roleByMemberId = buildPanelRoleMap([
		{
			roleDefinitionId: "rd-gram",
			slotIndex: 0,
			roleName: "Grammarian",
			status: "claimed",
			assigneeId: "m1",
		},
	]);

	const renderRail = () =>
		render(
			<MeetingAttendancePanel
				mode="plan"
				roster={roster}
				plan={[]}
				rungOverride={{}}
				roleByMemberId={roleByMemberId}
				meetingDate="Tue 9 Sep"
				shareUrl={SHARE_URL}
				dutiesByMemberId={{ m1: WORD_DUTY }}
				personalNudgeBase={PERSONAL}
				locked={false}
				onWriteRung={vi.fn()}
				onContacted={vi.fn()}
			/>,
		);

	const rowLink = (name: string) =>
		screen.getByRole("link", { name: new RegExp(`${name} on WhatsApp`, "i") });

	it("tells a role-holder what they still owe, on their own page", () => {
		renderRail();
		const text = draftText(rowLink("Jane Doe"));
		expect(text).toContain("you're our Grammarian");
		expect(text).toContain("you'll also need to set the Word of the Day");
		expect(text).toContain("/me?as=m1");
	});

	it("leaves the role-less row's attendance draft exactly as it was", () => {
		renderRail();
		const text = draftText(rowLink("Sam Rivera"));
		expect(text).toContain("are you able to make our Tue 9 Sep meeting?");
		// No duty, and the PUBLIC agenda — this draft asks about the meeting, so
		// the meeting page is the page that answers it.
		expect(text).not.toContain("also need");
		expect(text).toContain(`Agenda here: ${SHARE_URL}`);
		expect(text).not.toContain("?as=");
	});
});

describe("the agenda slot card's confirm draft", () => {
	afterEach(() => cleanup());

	const noop = async () => {};
	const actions: MeetingAgendaActions = {
		claim: noop,
		release: noop,
		addSpeaker: noop,
		removeSpeaker: noop,
		confirm: noop,
		unconfirm: noop,
		moveSpeaker: noop,
		removeRole: noop,
		takeover: noop,
		onMutated: noop,
	};

	const slot = (over: Partial<AgendaSlot>): AgendaSlot =>
		({
			id: "s1",
			roleName: "Grammarian",
			roleKey: GRAMMARIAN_ROLE_KEY,
			roleDefinitionId: "rd-gram",
			category: "functionary",
			isSpeakerRole: false,
			slotIndex: 0,
			status: "claimed",
			assigneeId: "m1",
			assigneeName: "Jane Doe",
			holderPhone: "14155552671",
			holderEmail: null,
			holderPreferredName: null,
			speechTitle: null,
			evaluates: null,
			...over,
		}) as unknown as AgendaSlot;

	const renderCard = (
		slots: AgendaSlot[],
		meetingOver: Partial<{ theme: string | null; wordOfTheDay: string | null }>,
		roster: MeetingAgendaProps["roster"] = [],
	) =>
		render(
			<MeetingAgenda
				slots={slots}
				viewer={meetingViewer({
					currentMemberId: "me",
					canManage: true,
					isTmod: false,
					isGrammarian: false,
					isEditableWindow: true,
				})}
				actions={actions}
				roster={roster}
				roleRecency={{}}
				roleByMemberId={{}}
				unavailableMemberIds={[]}
				shareUrl={SHARE_URL}
				meetingDate="Tue 9 Sep"
				personalNudgeBase={PERSONAL}
				meeting={
					{
						id: "mtg",
						scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
						status: "scheduled",
						lengthMinutes: 90,
						theme: null,
						wordOfTheDay: null,
						...meetingOver,
					} as unknown as MeetingAgendaProps["meeting"]
				}
				templateKey={null}
				timezone="UTC"
				selfMemberId="me"
				onMetaSaved={() => {}}
				contactedMemberIds={[]}
			/>,
		);

	it("names the holder's outstanding duty and links to their own page", () => {
		renderCard([slot({})], {});
		const text = draftText(whatsapp());
		expect(text).toContain("you'll also need to set the Word of the Day");
		expect(text).toContain("/club/mcf/meeting/2026-09-09/me?as=m1");
	});

	it("goes quiet once the Word of the Day is set", () => {
		// The meeting-wide half of the duty context, wired from `meeting` — drop
		// `wordOfTheDay` out of the call and the clause comes back on a job the
		// club has already done.
		renderCard([slot({})], { wordOfTheDay: "Ebullient" });
		const text = draftText(whatsapp());
		expect(text).not.toContain("Word of the Day");
		expect(text).toContain("Details: ");
	});

	it("reads the speech title off the SLOT, not off the meeting", () => {
		// The per-slot half of the duty context. Wired to a constant instead, a
		// speaker who has written their talk keeps being chased about it — and
		// the two meeting-wide fields beside it would still look correct.
		const speaker = {
			roleName: "Speaker",
			roleKey: "speaker",
			roleDefinitionId: "rd-speaker",
			isSpeakerRole: true,
		};
		renderCard([slot({ ...speaker, speechTitle: "Why I run" })], {});
		expect(draftText(whatsapp())).not.toContain("speech details");
		cleanup();
		// "TBA" is the app's own placeholder for an undecided speech, so a
		// non-blank check here reads it as a finished talk.
		renderCard([slot({ ...speaker, speechTitle: "TBA" })], {});
		expect(draftText(whatsapp())).toContain("add your speech details");
	});

	it("hands the same duties to the OPEN slot's recruit picker", async () => {
		// The card's other draft, and the one an agenda-level test is the only
		// thing that can see: the picker takes `duties` and `personalNudgeBase`
		// from this call site, and severing either here leaves the picker's own
		// suite green because that suite supplies them itself.
		const user = userEvent.setup();
		renderCard(
			[slot({ status: "open", assigneeId: null, assigneeName: null })],
			{},
			[
				{
					id: "m9",
					name: "Priya Raman",
					preferredName: null,
					phone: "14155552671",
					email: null,
				},
			],
		);
		await user.click(screen.getByRole("button", { name: /nudge someone/i }));
		await user.click(await screen.findByText("Priya Raman"));
		const text = draftText(
			await screen.findByRole("link", { name: /whatsapp/i }),
		);
		expect(text).toContain("You'd also need to set the Word of the Day");
		expect(text).toContain("/club/mcf/meeting/2026-09-09/me?as=m9");
	});

	it("keeps a GUEST holder's draft on the public link, with no ?as= to seed", () => {
		// A guest has no `members` row, so `assigneeId` is null — the same field
		// the outreach callback turns on. The draft must keep its link rather
		// than lose it.
		renderCard(
			[slot({ assigneeId: null, assigneeName: "Visiting Guest" })],
			{},
		);
		const text = draftText(whatsapp());
		// The duty is still theirs to do — only the personal link is unavailable,
		// so the draft falls back to the public agenda rather than losing its link.
		expect(text).toContain("set the Word of the Day");
		expect(text).toContain(`Confirm and do that here: ${SHARE_URL}`);
		// NOT `not.toContain("/me")` — the share URL itself contains "/meeting".
		expect(text).not.toContain("/me?as=");
	});
});

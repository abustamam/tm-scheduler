// @vitest-environment jsdom
//
// The screen agenda's (V) marker and its legend (#1164): a visiting Toastmaster
// reads "Name (V)" and the page carries one muted key line; a Visitor reads
// "Name · Guest" and a member the bare name, and with no (V) there is no key.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VISITING_TOASTMASTER_LEGEND } from "#/lib/agenda";
import type { Slide } from "#/lib/agenda-slides";
import { meetingViewer } from "#/lib/meeting-viewer";
import {
	type AgendaSlot,
	MeetingAgenda,
	type MeetingAgendaActions,
	type MeetingAgendaProps,
} from "./meeting-agenda";
import { MeetingPresent } from "./meeting-present";

// The sheets the agenda imports reach `#/db`; nothing here runs a handler.
vi.mock("#/db", () => ({ db: {} }));

// MeetingAgenda renders a router <Link> ("View agenda", #1336) and this suite
// mounts it router-less; a stand-in <a> keeps the render working.
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		Link: ({
			to,
			params,
			children,
			...rest
		}: {
			to: string;
			params?: Record<string, string>;
			children?: React.ReactNode;
		}) => (
			<a
				{...rest}
				href={to.replace(/\$(\w+)/g, (_, k: string) => params?.[k] ?? "")}
			>
				{children}
			</a>
		),
	};
});
// `MeetingPresent` polls vote participation; this file is about the key line.
vi.mock("#/server/voting", () => ({
	getVoteParticipation: vi.fn().mockResolvedValue({
		categories: {
			best_speaker: { ballotsIn: 0 },
			best_evaluator: { ballotsIn: 0 },
			best_table_topics: { ballotsIn: 0 },
		},
		presentCount: null,
	}),
}));

afterEach(cleanup);

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

function slot(over: Partial<AgendaSlot>): AgendaSlot {
	return {
		id: "s1",
		roleName: "Toastmaster",
		roleKey: "toastmaster_of_the_day",
		roleDefinitionId: "rd1",
		category: "leadership",
		isSpeakerRole: false,
		slotIndex: 0,
		status: "claimed",
		assigneeId: null,
		assigneeName: null,
		speechTitle: null,
		pathwayPath: null,
		projectName: null,
		projectLevel: null,
		minMinutes: null,
		maxMinutes: null,
		description: null,
		evaluates: null,
		...over,
	} as unknown as AgendaSlot;
}

const meeting = {
	id: "m1",
	scheduledAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
	status: "scheduled",
	lengthMinutes: 90,
	theme: "Beginnings",
	location: null,
	wordOfTheDay: null,
	wodDefinition: null,
	wodExample: null,
	notes: null,
} as unknown as MeetingAgendaProps["meeting"];

function renderAgenda(slots: AgendaSlot[]) {
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
			roster={[]}
			roleRecency={{}}
			roleByMemberId={{}}
			unavailableMemberIds={[]}
			shareUrl="https://gavelup.app/club/downtown/meeting/2026-10-13"
			meetingDate="Tue, Oct 13"
			meeting={meeting}
			meetingOver={false}
			contactedMemberIds={[]}
			personalNudgeBase={{
				origin: "https://gavelup.app",
				clubId: "downtown",
				meetingKey: "2026-10-13",
			}}
		/>,
	);
}

const guestSlot = (over: Partial<AgendaSlot>) =>
	slot({
		assigneeId: null,
		assigneeGuestId: "g1",
		assigneeIsGuest: true,
		assigneeName: "Jane Doe",
		...over,
	} as Partial<AgendaSlot>);

describe("the screen agenda's (V) key (#1164)", () => {
	// protects=a visiting Toastmaster reads "Jane Doe (V)" and the page carries the
	// one-line legend, once, however many (V) rows there are;
	// fails_when=the (V) is missing, "· Guest" still shows on that row, or the
	// legend is missing or repeated per row;
	// no_claim=its position under the run of show is a layout matter: jsdom does no
	// layout, so this proves presence and count, not placement.
	it("shows 'Name (V)' and the legend, once, when a visiting Toastmaster holds a slot", () => {
		renderAgenda([
			guestSlot({
				id: "a",
				assigneeIsVisitingToastmaster: true,
			} as Partial<AgendaSlot>),
			guestSlot({
				id: "b",
				roleName: "Timer",
				roleKey: "timer",
				roleDefinitionId: "rd2",
				assigneeName: "Bo Chen",
				assigneeIsVisitingToastmaster: true,
			} as Partial<AgendaSlot>),
		]);
		expect(screen.getByText("Jane Doe (V)")).toBeTruthy();
		expect(screen.getByText("Bo Chen (V)")).toBeTruthy();
		expect(screen.queryByText(/· Guest/)).toBeNull();
		expect(screen.getAllByText(VISITING_TOASTMASTER_LEGEND)).toHaveLength(1);
	});

	// protects=a Visitor reads "Name · Guest", a member the bare name, and with
	// no (V) on the page there is no legend line;
	// fails_when=the legend shows for a page with no visiting Toastmaster, or a
	// Visitor is given a (V);
	// no_claim=none beyond protects.
	it("shows no legend for a visitor or a member", () => {
		renderAgenda([
			guestSlot({
				id: "a",
				assigneeIsVisitingToastmaster: false,
			} as Partial<AgendaSlot>),
			slot({
				id: "b",
				roleName: "Timer",
				roleKey: "timer",
				roleDefinitionId: "rd2",
				assigneeId: "m2",
				assigneeName: "Ann Lee",
			}),
		]);
		expect(screen.getByText("Jane Doe · Guest")).toBeTruthy();
		expect(screen.getByText("Ann Lee")).toBeTruthy();
		expect(screen.queryByText(/\(V\)/)).toBeNull();
		expect(screen.queryByText(VISITING_TOASTMASTER_LEGEND)).toBeNull();
	});
});

describe("the projected deck's (V) key (#1164)", () => {
	const speech = (speaker: string, visiting?: true): Slide => ({
		kind: "speech",
		label: "First Speech",
		speaker,
		title: null,
		projectLevel: null,
		time: "5–7 min",
		link: null,
		...(visiting ? { visiting } : {}),
	});
	const present = (deck: Slide[]) => {
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={qc}>
				<MeetingPresent
					deck={deck}
					clubName="MCF Toastmasters Club"
					meetingId="11111111-1111-4111-8111-111111111111"
				/>
			</QueryClientProvider>,
		);
	};

	// protects=a content slide flagged `visiting` projects the key line, and the same
	// slide for a member, or one whose speaker is merely NAMED "Pat Lee (V)",
	// projects none;
	// fails_when=`MeetingPresent` stops drawing `body.legend`, or draws it for a
	// slide whose legend is null;
	// no_claim=that the line clears the footer on a crowded slide: that needs a
	// layout engine (slide-fit-geometry.test.ts measures the shrink).
	it("draws the legend under a slide that names a (V), and not under a member's", () => {
		present([speech("Jane Doe (V)", true)]);
		expect(screen.getByText("Speaker: Jane Doe (V)")).toBeTruthy();
		expect(screen.getAllByText(VISITING_TOASTMASTER_LEGEND)).toHaveLength(1);
		cleanup();
		present([speech("Jane Doe")]);
		expect(screen.getByText("Speaker: Jane Doe")).toBeTruthy();
		expect(screen.queryByText(VISITING_TOASTMASTER_LEGEND)).toBeNull();
		cleanup();
		present([speech("Pat Lee (V)")]);
		expect(screen.getByText("Speaker: Pat Lee (V)")).toBeTruthy();
		expect(screen.queryByText(VISITING_TOASTMASTER_LEGEND)).toBeNull();
	});
});

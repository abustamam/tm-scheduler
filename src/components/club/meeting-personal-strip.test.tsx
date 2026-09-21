// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanStatus } from "#/lib/attendance-panel";
import type { AttendanceStatus } from "#/server/minutes-logic";
import { MeetingPersonalStrip } from "./meeting-personal-strip";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const MEMBER = { id: "m1", name: "Nina Petrov" };

const BASE = {
	source: "anon" as "anon" | "session",
	member: null as typeof MEMBER | null,
	promptIdentity: vi.fn(),
	over: false,
	myStatus: null as PlanStatus | null,
	myAttendance: undefined as AttendanceStatus | null | undefined,
	availBusy: false,
	canToggleAvailability: true,
	onSetStatus: vi.fn(),
};

function renderStrip(overrides: Partial<typeof BASE> = {}) {
	render(<MeetingPersonalStrip {...BASE} {...overrides} />);
}

describe("MeetingPersonalStrip (#541 D3)", () => {
	it("guest without identity: viewing-as line, NO availability control", async () => {
		renderStrip();
		expect(screen.getByText(/viewing as guest/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /can't make/i })).toBeNull();
		await userEvent.click(
			screen.getByRole("button", { name: /i'm a member/i }),
		);
		expect(BASE.promptIdentity).toHaveBeenCalledOnce();
	});

	it("anon with identity: signing-up-as line AND the availability chip", () => {
		renderStrip({ member: MEMBER });
		expect(screen.getByText("Nina Petrov")).toBeTruthy();
		const chip = screen.getByRole("button", {
			name: /i can't make this one/i,
		});
		expect(chip).toBeTruthy();
		expect(chip.dataset.variant).toBe("outline");
	});

	it("signed-in member: chip only, no redundant identity line", () => {
		renderStrip({ source: "session", member: MEMBER });
		expect(screen.queryByText(/signing up as/i)).toBeNull();
		expect(
			screen.getByRole("button", { name: /i can't make this one/i }),
		).toBeTruthy();
	});

	it("marked unavailable: chip carries the state and the inline undo", async () => {
		const onSetStatus = vi.fn();
		renderStrip({
			// SESSION. Since #762 the undo is `clearPlannedAttendance`, which
			// destroys an answer and so needs one; an anon fixture here would
			// render the statement instead and this case would stop being about
			// the chip. The variant assertions below are the whole point of it.
			source: "session",
			member: MEMBER,
			myStatus: "not_coming",
			onSetStatus,
		});
		const chip = screen.getByRole("button", { name: /undo/i });
		expect(chip.textContent).toMatch(/can't make this one — undo\?/i);
		// `secondary`, not `default`: the marked state must read as an engaged
		// toggle WITHOUT wearing `bg-primary`, because this strip renders directly
		// above the toolbar and `default` put a second filled control in the
		// header next to the phase primary. See the composition test in
		// meeting-chrome-composition.test.tsx, which is the only gate that can
		// see that — each component alone looks fine.
		expect(chip.dataset.variant).toBe("secondary");
		// And it must stay visually distinct from the unmarked state, or the
		// fix above would have silently deleted the state signal.
		expect(chip.dataset.variant).not.toBe("outline");
		await userEvent.click(chip);
		expect(onSetStatus).toHaveBeenCalledWith(null);
	});

	it("anon viewer who has answered: a STATEMENT, never an undo that refuses (#762)", async () => {
		// `clearPlannedAttendance` needs a session (ADR-0026), so the inline undo
		// is a control this viewer cannot run. Offering it means every tap ends
		// in a refusal toast, and the surface that exists to make answering easy
		// teaches that answering is broken.
		const onSetStatus = vi.fn();
		renderStrip({ member: MEMBER, myStatus: "not_coming", onSetStatus });
		expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
		// The same sentence, minus the affordance — the state signal must not go
		// with the control.
		expect(screen.getByText(/you can't make this one\./i)).toBeTruthy();
		expect(screen.getByText(/sign in to change your answer/i)).toBeTruthy();
		expect(onSetStatus).not.toHaveBeenCalled();
	});

	it("anon viewer who said COMING gets the matching statement", async () => {
		// Both rungs, because the chip carried both and a one-rung test would
		// leave the other reading the wrong sentence.
		renderStrip({ member: MEMBER, myStatus: "coming" });
		expect(screen.getByText(/you'll be there\./i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
	});

	it("anon viewer with NO answer still gets both buttons — the control", async () => {
		// The fill-blank write is still open to them, so the answer buttons must
		// survive. Without this, removing the undo could pass equally well with
		// the whole anon control gone.
		renderStrip({ member: MEMBER, myStatus: null });
		expect(screen.getByRole("button", { name: /i'll be there/i })).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /i can't make this one/i }),
		).toBeTruthy();
	});

	it("meeting over: attendance statement replaces the chip", () => {
		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: null,
			myAttendance: "present",
		});
		expect(screen.getByText(/you attended this meeting/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /can't make/i })).toBeNull();
	});

	it("meeting over + marked unavailable: did-not-attend statement", () => {
		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: "not_coming",
			myAttendance: "absent",
		});
		expect(screen.getByText(/you did not attend this meeting/i)).toBeTruthy();
	});

	it("meeting over + NO identity: viewing-as line only — no attendance claim about nobody (review 3A)", () => {
		renderStrip({ over: true, member: null });
		expect(screen.getByText(/viewing as guest/i)).toBeTruthy();
		expect(screen.queryByText(/attended this meeting/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /can't make/i })).toBeNull();
	});

	it("respects canToggleAvailability=false by disabling, not hiding", () => {
		renderStrip({
			member: MEMBER,
			canToggleAvailability: false,
		});
		const chip = screen.getByRole("button", { name: /i can't make this one/i });
		expect((chip as HTMLButtonElement).disabled).toBe(true);
	});

	it("busy: spinner shows, name survives, clicks are inert", async () => {
		const onSetStatus = vi.fn();
		renderStrip({
			member: MEMBER,
			availBusy: true,
			onSetStatus,
		});
		const chip = screen.getByRole("button", {
			name: /i can't make this one/i,
		});
		expect(chip.getAttribute("aria-busy")).toBe("true");
		expect(chip.querySelector(".animate-spin")).toBeTruthy();
		expect((chip as HTMLButtonElement).disabled).toBe(true);
		await userEvent.click(chip);
		expect(onSetStatus).not.toHaveBeenCalled();
	});

	it("offers both answers, and never the officer-only rung", () => {
		const onSetStatus = vi.fn();
		const { getByRole, queryByRole } = render(
			<MeetingPersonalStrip
				source="anon"
				member={{ id: "m1", name: "Ayesha" } as never}
				promptIdentity={() => {}}
				over={false}
				myStatus={null}
				availBusy={false}
				canToggleAvailability={true}
				onSetStatus={onSetStatus}
			/>,
		);
		fireEvent.click(getByRole("button", { name: "I'll be there" }));
		expect(onSetStatus).toHaveBeenCalledWith("coming");
		// `reached_out` is an officer's record of having asked. A member offering it
		// about themselves is nonsense, and the server rejects it.
		expect(queryByRole("button", { name: /asked/i })).toBeNull();
	});

	it("lets you take back an answer you already gave", () => {
		const onSetStatus = vi.fn();
		const { getByRole } = render(
			<MeetingPersonalStrip
				source="session"
				member={{ id: "m1", name: "Ayesha" } as never}
				promptIdentity={() => {}}
				over={false}
				myStatus="coming"
				availBusy={false}
				canToggleAvailability={true}
				onSetStatus={onSetStatus}
			/>,
		);
		fireEvent.click(getByRole("button", { name: /undo/i }));
		expect(onSetStatus).toHaveBeenCalledWith(null);
	});
});

describe("the over-state attendance statement (#548)", () => {
	/** All three statements end in "this meeting." — asserting on that one pattern
	 *  catches the excused string too. Asserting only /attended/ and /did not
	 *  attend/ would let a wrong "You were excused from this meeting." through. */
	const ANY_STATEMENT = /this meeting\./i;

	it("tells a signed-in member the truth from the RECORDED row", () => {
		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: null,
			myAttendance: "present",
		});
		expect(screen.getByText("You attended this meeting.")).toBeTruthy();
		cleanup();

		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			// The plan said COMING and the record says ABSENT. The record wins —
			// that disagreement is exactly the lie #548 filed, so this fixture is
			// the one that separates the two sources.
			myStatus: "coming",
			myAttendance: "absent",
		});
		expect(screen.getByText("You did not attend this meeting.")).toBeTruthy();
		cleanup();

		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: null,
			myAttendance: "excused",
		});
		expect(
			screen.getByText("You were excused from this meeting."),
		).toBeTruthy();
	});

	it("says nothing about attendance when nobody recorded a row", () => {
		// A session exists, so we KNOW there is no row. Claiming either way would
		// be inventing a record.
		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: "coming",
			myAttendance: null,
		});
		expect(screen.queryByText(ANY_STATEMENT)).toBeNull();
	});

	it("says nothing about attendance to a viewer we cannot verify", () => {
		// DP2: an anonymous roster-pick member — the dominant identity path here.
		// Telling them anything would need a public array of everyone's
		// attendance, which widens "who was absent" to any visitor, and #574 is
		// still open on a milder version of that.
		renderStrip({
			source: "anon",
			member: MEMBER,
			over: true,
			myStatus: "coming",
			myAttendance: undefined,
		});
		expect(screen.queryByText(ANY_STATEMENT)).toBeNull();
	});

	it("never derives the statement from the plan ladder", () => {
		// The regression guard. `myStatus` alone must not produce a claim, or the
		// bug walks straight back in the next time someone simplifies this branch.
		renderStrip({
			source: "session",
			member: MEMBER,
			over: true,
			myStatus: "not_coming",
			myAttendance: undefined,
		});
		expect(screen.queryByText(ANY_STATEMENT)).toBeNull();
	});
});

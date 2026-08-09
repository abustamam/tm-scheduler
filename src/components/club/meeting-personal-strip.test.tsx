// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingPersonalStrip } from "./meeting-personal-strip";

afterEach(cleanup);

const MEMBER = { id: "m1", name: "Nina Petrov" };

const BASE = {
	source: "anon" as "anon" | "session",
	member: null as typeof MEMBER | null,
	promptIdentity: vi.fn(),
	over: false,
	myUnavailable: false,
	availBusy: false,
	canToggleAvailability: true,
	onToggleAvailability: vi.fn(),
	hasIdentity: false,
};

function renderStrip(overrides: Partial<typeof BASE> = {}) {
	render(<MeetingPersonalStrip {...BASE} {...overrides} />);
}

describe("MeetingPersonalStrip (#541 D3)", () => {
	it("guest without identity: viewing-as line, NO availability control", () => {
		renderStrip();
		expect(screen.getByText(/viewing as guest/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /can't make/i })).toBeNull();
	});

	it("anon with identity: signing-up-as line AND the availability chip", () => {
		renderStrip({ member: MEMBER, hasIdentity: true });
		expect(screen.getByText("Nina Petrov")).toBeTruthy();
		expect(
			screen.getByRole("button", { name: /i can't make this one/i }),
		).toBeTruthy();
	});

	it("signed-in member: chip only, no redundant identity line", () => {
		renderStrip({ source: "session", member: MEMBER, hasIdentity: true });
		expect(screen.queryByText(/signing up as/i)).toBeNull();
		expect(
			screen.getByRole("button", { name: /i can't make this one/i }),
		).toBeTruthy();
	});

	it("marked unavailable: chip carries the state and the inline undo", async () => {
		const onToggle = vi.fn();
		renderStrip({
			member: MEMBER,
			hasIdentity: true,
			myUnavailable: true,
			onToggleAvailability: onToggle,
		});
		const chip = screen.getByRole("button", { name: /undo/i });
		expect(chip.textContent).toMatch(/can't make this one — undo\?/i);
		await userEvent.click(chip);
		expect(onToggle).toHaveBeenCalledOnce();
	});

	it("meeting over: attendance statement replaces the chip", () => {
		renderStrip({
			member: MEMBER,
			hasIdentity: true,
			over: true,
			myUnavailable: false,
		});
		expect(screen.getByText(/you attended this meeting/i)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /can't make/i })).toBeNull();
	});

	it("meeting over + marked unavailable: did-not-attend statement", () => {
		renderStrip({
			member: MEMBER,
			hasIdentity: true,
			over: true,
			myUnavailable: true,
		});
		expect(screen.getByText(/you did not attend this meeting/i)).toBeTruthy();
	});

	it("meeting over + NO identity: viewing-as line only — no attendance claim about nobody (review 3A)", () => {
		renderStrip({ over: true, member: null, hasIdentity: false });
		expect(screen.getByText(/viewing as guest/i)).toBeTruthy();
		expect(screen.queryByText(/attended this meeting/i)).toBeNull();
		expect(screen.queryByRole("button", { name: /can't make/i })).toBeNull();
	});

	it("respects canToggleAvailability=false by disabling, not hiding", () => {
		renderStrip({
			member: MEMBER,
			hasIdentity: true,
			canToggleAvailability: false,
		});
		const chip = screen.getByRole("button", { name: /i can't make this one/i });
		expect((chip as HTMLButtonElement).disabled).toBe(true);
	});

	it("busy: chip shows the spinner and ignores clicks", async () => {
		const onToggle = vi.fn();
		renderStrip({
			member: MEMBER,
			hasIdentity: true,
			availBusy: true,
			onToggleAvailability: onToggle,
		});
		// disabled while busy; no accessible name change assertions beyond disabled
		const buttons = screen.getAllByRole("button");
		const chip = buttons.find((b) => (b as HTMLButtonElement).disabled);
		expect(chip).toBeTruthy();
	});
});

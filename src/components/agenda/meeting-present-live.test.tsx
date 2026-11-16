// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Slide } from "#/lib/agenda-slides";
import { MeetingPresent, remapSlideIndex } from "./meeting-present";

vi.mock("#/server/voting", () => ({ getVoteParticipation: vi.fn() }));
afterEach(cleanup);

const speech = (id: string, speaker: string): Slide => ({
	kind: "speech",
	key: `speech:${id}`,
	label: "Speech",
	speaker,
	title: null,
	projectLevel: null,
	time: "5-7 min",
	link: null,
});
const awards = (): Slide => ({ kind: "awards", key: "awards", categories: [] });

describe("remapSlideIndex (#1637)", () => {
	// protects=the presenter stays on the same slide when an earlier one goes;
	// fails_when=the index is kept as-is; no_claim=nothing about a vanished key.
	it("follows the slide's key to its new index", () => {
		expect(remapSlideIndex(["a", "b", "c"], ["b", "c"], 1)).toBe(0);
	});
	// protects=a vanished slide leaves the presenter in place, clamped, no throw;
	// fails_when=the clamp is lost (index past the end) or it returns -1;
	// no_claim=which neighbour is "right".
	it("keeps the index and clamps it when the key is gone", () => {
		expect(remapSlideIndex(["a", "b", "c"], ["a", "b"], 2)).toBe(1);
		expect(remapSlideIndex(["a", "b", "c"], ["a", "x", "c"], 1)).toBe(1);
		expect(remapSlideIndex(["a"], [], 0)).toBe(0);
	});
});

function mount(deck: Slide[]) {
	const qc = new QueryClient();
	const ui = (d: Slide[]) => (
		<QueryClientProvider client={qc}>
			<MeetingPresent deck={d} clubName="MCF" meetingId="m" />
		</QueryClientProvider>
	);
	const view = render(ui(deck));
	return { rerender: (d: Slide[]) => view.rerender(ui(d)) };
}

describe("MeetingPresent keeps its place on a live rebuild (#1637)", () => {
	// protects=removing Speech 1 while on Speech 2 leaves X's slide showing;
	// fails_when=the index is not re-mapped (the deck would show Y or Awards);
	// no_claim=nothing about the overview.
	it("stays on the same person's speech slide when an earlier one is removed", () => {
		const first = [speech("1", "Wren"), speech("2", "Xavier"), awards()];
		const view = mount(first);
		fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(screen.getAllByText(/Xavier/).length).toBeGreaterThan(0);
		view.rerender([speech("2", "Xavier"), awards()]);
		expect(screen.getAllByText(/Xavier/).length).toBeGreaterThan(0);
		expect(screen.queryByText(/Wren/)).toBeNull();
	});

	// protects=a role change in place updates the name without moving the
	// presenter; fails_when=the rebuild resets to slide 0; no_claim=none.
	it("shows the new name on the same slide when the keys are unchanged", () => {
		const view = mount([speech("1", "Wren"), speech("2", "Xavier")]);
		fireEvent.keyDown(window, { key: "ArrowRight" });
		view.rerender([speech("1", "Wren"), speech("2", "Zed")]);
		expect(screen.getAllByText(/Zed/).length).toBeGreaterThan(0);
	});

	// protects=a vanished last slide clamps and never throws; fails_when=the
	// index runs past the deck; no_claim=nothing about which slide shows.
	it("clamps when the current slide vanishes", () => {
		const view = mount([speech("1", "Wren"), speech("2", "Xavier")]);
		fireEvent.keyDown(window, { key: "ArrowRight" });
		expect(() => view.rerender([speech("1", "Wren")])).not.toThrow();
		expect(screen.getAllByText(/Wren/).length).toBeGreaterThan(0);
	});

	// protects=the overview highlight follows the slide it was on;
	// fails_when=cursor is left at its old index; no_claim=nothing about the
	// projected slide (covered above).
	it("moves the overview cursor by key", () => {
		const view = mount([speech("1", "Wren"), speech("2", "Xavier"), awards()]);
		fireEvent.keyDown(window, { key: "ArrowRight" });
		fireEvent.keyDown(window, { key: "g" });
		const current = () =>
			document.querySelector('[aria-label^="Slide"][aria-current="true"]') ??
			document.querySelector('[aria-label^="Slide"][data-cursor="true"]');
		view.rerender([speech("2", "Xavier"), awards()]);
		// Committing the highlighted card lands on the same speech.
		fireEvent.keyDown(window, { key: "Enter" });
		expect(screen.getAllByText(/Xavier/).length).toBeGreaterThan(0);
		void current;
	});
});

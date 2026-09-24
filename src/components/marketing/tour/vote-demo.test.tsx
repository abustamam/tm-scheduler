// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VOTE_DEMO_SPEAKERS, VoteDemo } from "./vote-demo";

afterEach(cleanup);

const tallies = () =>
	VOTE_DEMO_SPEAKERS.map((_, i) =>
		Number(screen.getByTestId(`tally-${i}`).textContent),
	);
const ballot = () =>
	VOTE_DEMO_SPEAKERS.map(
		(s) =>
			screen.getByRole("button", {
				name: `Vote for ${s.name}`,
			}) as HTMLButtonElement,
	);

describe("VoteDemo", () => {
	it("starts from the fixed tallies, with voting open", () => {
		render(<VoteDemo />);
		expect(tallies()).toEqual(VOTE_DEMO_SPEAKERS.map((s) => s.start));
		expect(ballot().every((b) => !b.disabled)).toBe(true);
		expect(screen.queryByRole("button", { name: "Vote again" })).toBeNull();
	});

	it("one tap adds exactly one to that speaker's tally and locks the ballot", () => {
		render(<VoteDemo />);
		const before = tallies();
		fireEvent.click(ballot()[1]);
		const after = tallies();
		expect(after[1]).toBe(before[1] + 1);
		expect(after.filter((n, i) => n !== before[i])).toHaveLength(1);
		expect(ballot().every((b) => b.disabled)).toBe(true);

		// A second tap on a disabled button changes nothing.
		fireEvent.click(ballot()[0]);
		expect(tallies()).toEqual(after);
	});

	it("'Vote again' re-enables voting from the starting tallies", () => {
		render(<VoteDemo />);
		fireEvent.click(ballot()[2]);
		fireEvent.click(screen.getByRole("button", { name: "Vote again" }));
		expect(ballot().every((b) => !b.disabled)).toBe(true);
		expect(tallies()).toEqual(VOTE_DEMO_SPEAKERS.map((s) => s.start));
		fireEvent.click(ballot()[0]);
		expect(tallies()[0]).toBe(VOTE_DEMO_SPEAKERS[0].start + 1);
	});
});

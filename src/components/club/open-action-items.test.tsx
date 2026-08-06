// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionItemRow } from "#/server/action-items-logic";
import { OpenActionItems } from "./open-action-items";

// The component's type import pulls in the logic module, which imports `#/db`.
vi.mock("#/db", () => ({ db: {} }));

function row(over: Partial<ActionItemRow>): ActionItemRow {
	return {
		id: "a1",
		text: "Book the venue",
		ownerMemberId: null,
		ownerName: null,
		dueDate: null,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		resolvedAt: null,
		resolution: null,
		...over,
	};
}

describe("OpenActionItems (#529)", () => {
	afterEach(() => cleanup());

	it("says how many rows the cap hid", () => {
		// Regression: found by /qa on 2026-08-05 against a club with 47 open items.
		// This surface rendered exactly 40 and said nothing about the other 7, so
		// the list read as the club's complete outstanding work. The minutes
		// surface already had the tail; this one was written without it, and no
		// test covered the component at all.
		// Report: .gstack/qa-reports/qa-report-localhost-2026-08-05.md
		render(
			<OpenActionItems
				items={Array.from({ length: 40 }, (_, i) =>
					row({ id: `a${i}`, text: `Item ${i}` }),
				)}
				total={47}
			/>,
		);
		expect(screen.getByText("+7 more not shown")).toBeTruthy();
	});

	it("adds no tail when nothing was hidden", () => {
		render(<OpenActionItems items={[row({})]} total={1} />);
		expect(screen.queryByText(/more not shown/)).toBeNull();
	});

	it("renders an unowned item with no owner name", () => {
		render(
			<OpenActionItems
				items={[row({ text: "Everyone bring a guest" })]}
				total={1}
			/>,
		);
		expect(screen.getByText("Everyone bring a guest")).toBeTruthy();
		expect(screen.queryByText(/The club/)).toBeNull();
	});

	it("shows the owner and the due date as the day that was picked", () => {
		render(
			<OpenActionItems
				items={[row({ ownerName: "Grace Kim", dueDate: "2026-09-01" })]}
				total={1}
			/>,
		);
		// "Sep 1", never "Aug 31" — a due date is a calendar day, not an instant.
		expect(screen.getByText(/Grace Kim/)).toBeTruthy();
		expect(screen.getByText(/Sep 1/)).toBeTruthy();
	});

	it("renders nothing when there is no open work", () => {
		const { container } = render(<OpenActionItems items={[]} total={0} />);
		expect(container.innerHTML).toBe("");
	});
});

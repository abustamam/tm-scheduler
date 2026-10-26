// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewCell } from "#/lib/season-grid-view";
import { CELL_BASE, GridCell } from "./grid-cell";

// MeetingLink needs a router; the span inside it is what carries the classes.
vi.mock("./meeting-link", () => ({
	MeetingLink: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(cleanup);

// ViewCell shape verified against src/lib/season-grid-view.ts (all six fields).
const openCell: ViewCell = {
	meetingId: "meeting-1",
	kind: "open",
	text: "Timer",
	title: "Timer",
	slotId: "slot-1",
	memberId: null,
};

describe("GridCell prospective claim", () => {
	// The claim branch of GridCell returns a plain <button> (no <Link>), so no
	// router harness is needed — render it directly.
	it("shows Claim and fires onClaim even with no identity", async () => {
		const onClaim = vi.fn();
		render(
			<GridCell
				cell={openCell}
				currentMemberId={null}
				prospectiveClaim
				onClaim={onClaim}
			/>,
		);
		const btn = await screen.findByRole("button", { name: /claim/i });
		await userEvent.click(btn);
		expect(onClaim).toHaveBeenCalledWith("slot-1");
	});
});

// Each test below: protects = the class set DESIGN.md gives that cell state;
// fails_when = a state drifts back to another state's hue (green Claim, solid
// green taken); no_claim = class names do not prove contrast, which is argued
// in the comment in grid-cell.tsx.
describe("GridCell state classes (#1308)", () => {
	const cls = (el: HTMLElement) => el.className.split(/\s+/);
	const noTextOpacity = (c: string[]) =>
		expect(c.filter((x) => /^text-[a-z-]+\/\d+$/.test(x))).toEqual([]);
	const memberCell: ViewCell = {
		...openCell,
		kind: "assigned",
		text: "Ana",
		title: "Timer: Ana",
		memberId: "m-2",
	};
	const spanOf = (text: string) => screen.getByText(text);

	it("claim cell is amber and carries no success class", () => {
		render(
			<GridCell cell={openCell} currentMemberId="m-1" onClaim={vi.fn()} />,
		);
		const c = cls(screen.getByRole("button", { name: /^Claim/ }));
		expect(c).toEqual(
			expect.arrayContaining([
				"border-warning",
				"bg-warning-soft",
				"text-warning-foreground",
			]),
		);
		expect(c.filter((x) => x.includes("success"))).toEqual([]);
		noTextOpacity(c);
	});

	it("open read-only cell is dashed amber with a full-strength border", () => {
		render(<GridCell cell={openCell} clubSlug="c" meetingKey="2026-01-01" />);
		const c = cls(spanOf("Timer"));
		expect(c).toEqual(
			expect.arrayContaining([
				"border-dashed",
				"border-warning",
				"text-warning-foreground",
			]),
		);
		expect(c).not.toContain("border-warning/60");
	});

	it("taken cell on a read-only grid is tinted, not solid green", () => {
		render(<GridCell cell={memberCell} clubSlug="c" meetingKey="2026-01-01" />);
		const c = cls(spanOf("Ana"));
		expect(c).toEqual(
			expect.arrayContaining(["bg-success/15", "text-foreground"]),
		);
		expect(c).not.toContain("bg-success");
	});

	it("taken cell on the interactive grid is tinted, with no conflicting solid bg", () => {
		render(
			<GridCell
				cell={memberCell}
				currentMemberId="m-1"
				clubSlug="c"
				meetingKey="k"
			/>,
		);
		const c = cls(spanOf("Ana"));
		expect(c).toEqual(
			expect.arrayContaining(["bg-success/15", "text-foreground"]),
		);
		expect(c).not.toContain("bg-success");
	});

	it("mine keeps the solid fill and the strong ring", () => {
		render(
			<GridCell
				cell={{ ...memberCell, memberId: "m-1", text: "Me" }}
				currentMemberId="m-1"
				onRelease={vi.fn()}
			/>,
		);
		const c = cls(screen.getByRole("button", { name: /^Release/ }));
		expect(c).toEqual(
			expect.arrayContaining(["bg-success", "ring-2", "ring-success-strong"]),
		);
	});

	it("free cell text has no opacity modifier; cells are 14px", () => {
		render(
			<GridCell
				cell={{ ...openCell, kind: "free", text: "—", slotId: null }}
				clubSlug="c"
				meetingKey="k"
			/>,
		);
		const c = cls(spanOf("—"));
		expect(c).toContain("text-muted-foreground");
		noTextOpacity(c);
		expect(CELL_BASE).toContain("text-sm");
		expect(CELL_BASE).not.toContain("text-xs");
	});
});

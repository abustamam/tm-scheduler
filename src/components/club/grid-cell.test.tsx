// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewCell } from "#/lib/season-grid-view";
import { expectAmberClaim } from "./claim-class-assert";
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

// Class names do not prove contrast; that is argued, with ratios, in the
// comment at the top of grid-cell.tsx.
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

	// protects: the interactive Claim cell uses the exact amber token set (AC 1)
	// fails_when: Claim goes back to green, or the border/fill/text token gains a modifier such as /60
	// no_claim: class names, not contrast or rendered color.
	it("claim cell is amber and carries no success class", () => {
		render(
			<GridCell cell={openCell} currentMemberId="m-1" onClaim={vi.fn()} />,
		);
		const c = cls(screen.getByRole("button", { name: /^Claim/ }));
		expectAmberClaim(c.join(" "));
		noTextOpacity(c);
	});

	// protects: the read-only open cell is dashed amber at full border strength
	// fails_when: the border returns to border-warning/60 or loses the dash
	// no_claim: class names, not contrast or rendered color.
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

	// protects: someone else's taken cell on the public grid is a bg-success/15 tint (AC 2)
	// fails_when: the cell becomes a solid bg-success fill like the viewer's own
	// no_claim: class names, not contrast or rendered color.
	it("taken cell on a read-only grid is tinted, not solid green", () => {
		render(
			<GridCell
				cell={memberCell}
				prospectiveClaim
				clubSlug="c"
				meetingKey="2026-01-01"
			/>,
		);
		const c = cls(spanOf("Ana"));
		expect(c).toEqual(
			expect.arrayContaining(["bg-success/15", "text-foreground"]),
		);
		expect(c).not.toContain("bg-success");
	});

	// protects: the interactive grid renders another member's cell as the same tint, with one bg class
	// fails_when: the interactive-only solid bg-success override comes back and stacks on the tint
	// no_claim: class names, not contrast or rendered color.
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

	// protects: the viewer's own cell stays visibly stronger than other members' tints
	// fails_when: mine is tinted like the others, or loses the ring
	// no_claim: class names, not contrast or rendered color.
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

	// protects: free-cell text is a verified full-strength color and CELL_BASE is 14px (AC 3)
	// fails_when: text-muted-foreground gains an /NN opacity, or CELL_BASE drops back to text-xs
	// no_claim: class names, not contrast or rendered color.
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

	// protects: the NA toggle's hover pair is two semantic tokens (destructive fill, primary-foreground text) with no raw palette color (AC 5)
	// fails_when: hover:text-white (or any raw palette class) comes back on the toggle
	// no_claim: class names, not contrast; the ratios are in grid-cell.tsx.
	it("NA toggle hover uses semantic tokens, no raw palette color", () => {
		render(
			<GridCell
				cell={{ ...openCell, kind: "na", text: "N/A", slotId: null }}
				availabilityEditable
				onAvailability={vi.fn()}
			/>,
		);
		const c = cls(screen.getByRole("button"));
		expect(c).toEqual(
			expect.arrayContaining([
				"hover:bg-destructive",
				"hover:text-primary-foreground",
			]),
		);
		expect(
			c.filter((x) => /(^|:)(text|bg|border)-(white|black)\b/.test(x)),
		).toEqual([]);
	});
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewCell } from "#/lib/season-grid-view";
import { GridCell } from "./grid-cell";

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

// @vitest-environment jsdom
//
// "Preview as Area Director" on the superadmin console's area page (#1119): the
// numbers the director sees, read through `previewConsoleArea` (the superadmin's
// own door; `getAreaHealth` refuses a superadmin with no term) and rendered by
// the same view as the director's page.
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { previewConsoleArea } = vi.hoisted(() => ({
	previewConsoleArea: vi.fn(),
}));
vi.mock("#/server/areas", () => ({ previewConsoleArea }));

import type { AreaHealth } from "#/lib/area-health";
import { AreaPreviewPanel } from "./area-preview-panel";

const AREA_ID = "3f0b5c1e-6a3d-4d1b-9f5e-2c7a8b9d0e1f";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const HEALTH: AreaHealth = {
	areaId: AREA_ID,
	label: "C3",
	programYear: 2026,
	asOf: "2026-10-09T14:32:00.000Z",
	clubs: [
		{
			areaClubId: "row-1",
			name: "Uptown Orators",
			clubNumber: "7654321",
			status: "not_on_gavelup",
			meetings: { tracked: false },
			roleFillRate: { tracked: false },
			attendance: { tracked: false },
			officers: { tracked: false },
			dcp: { tracked: false },
			renewals: { tracked: false },
		},
	],
};

describe("AreaPreviewPanel", () => {
	it("reads nothing until asked, then shows the director's view of the area", async () => {
		previewConsoleArea.mockResolvedValue(HEALTH);
		render(<AreaPreviewPanel areaId={AREA_ID} />);
		expect(screen.getByText("Preview as Area Director")).toBeTruthy();
		expect(previewConsoleArea).not.toHaveBeenCalled();
		expect(screen.queryByRole("table")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Show preview" }));

		await waitFor(() => expect(screen.getByRole("table")).toBeTruthy());
		expect(previewConsoleArea).toHaveBeenCalledWith({
			data: { areaId: AREA_ID },
		});
		expect(screen.getAllByText("Uptown Orators").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Not on GavelUp").length).toBeGreaterThan(0);
		expect(
			screen.getByRole("button", { name: "Refresh preview" }),
		).toBeTruthy();
	});

	it("shows the refusal instead of a table when the read fails", async () => {
		previewConsoleArea.mockRejectedValue(
			new Error("You don't have permission to do that."),
		);
		render(<AreaPreviewPanel areaId={AREA_ID} />);

		fireEvent.click(screen.getByRole("button", { name: "Show preview" }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("You don't have permission to do that.");
		expect(screen.queryByRole("table")).toBeNull();
	});
});

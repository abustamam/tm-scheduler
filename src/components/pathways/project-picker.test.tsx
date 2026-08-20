// @vitest-environment jsdom
//
// Covers the evaluation-resource link wired into ProjectPicker (#606-adjacent;
// spec 2026-08-20 task 3): the selected-project summary and each project row
// in the level list should each offer a link to the official TI evaluation
// resource. No `@testing-library/jest-dom` in this repo, so assertions use
// native DOM properties rather than `toBeInTheDocument` / `toHaveAttribute`.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectPicker } from "#/components/pathways/project-picker";
import type { PickerPath } from "#/server/project-picker";

const PATH: PickerPath = {
	pathId: "path-1",
	courseCode: "8701",
	name: "Presentation Mastery",
	status: "current",
	defaultLevel: 3,
	projects: [
		{
			id: "proj-1",
			level: 3,
			name: "Active Listening",
			isRequired: false,
			complete: false,
		},
	],
};

describe("ProjectPicker", () => {
	it("offers the evaluation resource for the selected project", () => {
		const { container } = render(
			<ProjectPicker
				paths={[PATH]}
				value="proj-1"
				onChange={() => {}}
				fallback={{ pathwayPath: null, projectName: null, projectLevel: null }}
			/>,
		);
		const link = container.querySelector('a[href*="toastmasters.org"]');
		expect(link).toBeTruthy();
	});
});

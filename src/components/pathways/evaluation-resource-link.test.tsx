// @vitest-environment jsdom
//
// No `@testing-library/jest-dom` in this repo, so every assertion below uses
// native DOM properties rather than `toBeInTheDocument` / `toHaveAttribute`.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvaluationResourceLinks } from "#/components/pathways/evaluation-resource-link";

describe("EvaluationResourceLinks", () => {
	it("links a known project to its TI resource, opening safely", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName="Active Listening" />,
		);
		const link = container.querySelector("a");
		expect(link).toBeTruthy();
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toContain("noopener");
		expect(link?.getAttribute("href")).toMatch(
			/^https:\/\/[^/]*toastmasters\.org\//,
		);
	});

	it("names each part when a project has several resources", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName="Evaluation and Feedback" />,
		);
		expect(container.querySelectorAll("a")).toHaveLength(3);
		const text = container.textContent ?? "";
		expect(text).toContain("First speech");
		expect(text).toContain("Second speech");
		expect(text).toContain("Evaluator role");
	});

	it("says so when it falls back to the generic resource", () => {
		// An unknown project must not be presented as if the form were its own.
		const { container } = render(
			<EvaluationResourceLinks projectName="Advanced Mentoring" />,
		);
		expect(container.textContent).toContain("Generic evaluation resource");
	});

	it("notes the current edition for a legacy-path project", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName="Active Listening (Legacy)" />,
		);
		expect(container.textContent).toContain("current edition");
	});

	it("does not note the edition for a current-path project", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName="Active Listening" />,
		);
		expect(container.textContent).not.toContain("current edition");
	});

	it("renders the same resource for a legacy project as its current twin", () => {
		const legacy = render(
			<EvaluationResourceLinks projectName="Active Listening (Legacy)" />,
		)
			.container.querySelector("a")
			?.getAttribute("href");
		const current = render(
			<EvaluationResourceLinks projectName="Active Listening" />,
		)
			.container.querySelector("a")
			?.getAttribute("href");
		expect(legacy).toBe(current);
		expect(legacy).toBeTruthy();
	});
});

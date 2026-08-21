// @vitest-environment jsdom
//
// No `@testing-library/jest-dom` in this repo, so every assertion below uses
// native DOM properties rather than `toBeInTheDocument` / `toHaveAttribute`.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvaluationResourceLinks } from "#/components/pathways/evaluation-resource-link";

// The exact TI resource for "Active Listening", per
// src/lib/evaluation-resources.ts. An absolute literal, NOT
// `resourcesForProject("Active Listening")[0].url`: deriving the expectation
// from the table under test passes for whatever that table returns. The pattern
// it replaced (`/^https:\/\/[^/]*toastmasters\.org\//`) was worse than weak —
// the generic 8053 URL satisfies it too, so it passed for a silently broken
// lookup, which is the exact failure this file exists to catch.
const ACTIVE_LISTENING_URL =
	"https://www.toastmasters.org/resources/-/media/d97ff6e633ad44dbaca0ddac5a6c0fb8.ashx";

describe("EvaluationResourceLinks", () => {
	it("links a known project to its TI resource, opening safely", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName="Active Listening" />,
		);
		const link = container.querySelector("a");
		expect(link).toBeTruthy();
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toContain("noopener");
		expect(link?.getAttribute("href")).toBe(ACTIVE_LISTENING_URL);
	});

	it("names the project in each link's accessible name", () => {
		// The picker dialog renders one of these per project row — ~30 links whose
		// visible text is the identical "Evaluation resource".
		const { container } = render(
			<EvaluationResourceLinks projectName="Active Listening" />,
		);
		expect(container.querySelector("a")?.getAttribute("aria-label")).toContain(
			"Active Listening",
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

	it("renders nothing for a project with no resource of its own", () => {
		// Spec §2: "A project with no resource renders no link." Reachable for a
		// Base-Camp-ingested project the catalog lacks — TI publishes 8202E for
		// Cross-Cultural Understanding, so the generic form would be a WRONG form
		// wearing an authoritative label.
		const { container } = render(
			<EvaluationResourceLinks projectName="Cross-Cultural Understanding" />,
		);
		expect(container.querySelectorAll("a")).toHaveLength(0);
		expect(container.textContent).toBe("");
	});

	it("renders nothing when there is no project at all", () => {
		for (const projectName of [null, undefined, ""]) {
			const { container } = render(
				<EvaluationResourceLinks projectName={projectName} />,
			);
			expect(container.querySelectorAll("a")).toHaveLength(0);
		}
	});

	it("offers the generic resource only when the call site opts in", () => {
		// An evaluator paired with a TBA speech still needs a usable form — spec
		// §3 step 3, which is why 8053 ships.
		const { container } = render(
			<EvaluationResourceLinks projectName="Advanced Mentoring" fallback />,
		);
		expect(container.textContent).toContain("Generic evaluation resource");
		expect(container.querySelectorAll("a")).toHaveLength(1);
	});

	it("offers the generic resource for a TBA speech when opted in", () => {
		const { container } = render(
			<EvaluationResourceLinks projectName={null} fallback />,
		);
		expect(container.querySelectorAll("a")).toHaveLength(1);
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

	it("attaches the edition caveat to the whole group, not the last link", () => {
		// Evaluation and Feedback is a required Level 1 project on all five legacy
		// paths, so every legacy-path member meets multi-part + (Legacy) at Level
		// 1. Trailing the third anchor inline, the caveat read as if it qualified
		// only that one.
		const { container } = render(
			<EvaluationResourceLinks projectName="Evaluation and Feedback (Legacy)" />,
		);
		expect(container.querySelectorAll("a")).toHaveLength(3);

		const note = [...container.querySelectorAll("p")].find((el) =>
			(el.textContent ?? "").includes("current edition"),
		);
		expect(note, "the caveat should be its own element").toBeTruthy();
		// Not inside any anchor, and a sibling of the whole link row rather than
		// trailing one link inside it — so it reads as covering all three.
		expect(note?.closest("a")).toBeNull();
		expect(note?.querySelectorAll("a")).toHaveLength(0);
		expect(note?.previousElementSibling?.querySelectorAll("a")).toHaveLength(3);
		expect(note?.textContent).toContain("these forms");
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
		expect(legacy).toBe(ACTIVE_LISTENING_URL);
	});
});

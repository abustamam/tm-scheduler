// @vitest-environment jsdom
/**
 * The picker's two quiz touch points (#935): it links to the quiz, and it
 * takes the quiz's handoff on the dashboard, opening with that path marked
 * while every other path stays selectable. Nothing is added until the member
 * picks.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PATH_QUIZ_HREF, QUIZ_HANDOFF_KEY } from "#/lib/path-quiz";
import type { EnrollablePath } from "#/server/path-enrollment";
import { PathEnrollmentManager } from "./path-enrollment-manager";

const OPTIONS: EnrollablePath[] = [
	{
		id: "p-8701",
		courseCode: "8701",
		name: "Presentation Mastery",
		status: "current",
	},
	{
		id: "p-8711",
		courseCode: "8711",
		name: "Engaging Humor",
		status: "current",
	},
	{
		id: "p-8707",
		courseCode: "8707",
		name: "Persuasive Influence",
		status: "current",
	},
	{
		id: "p-8705",
		courseCode: "8705",
		name: "Strategic Relationships",
		status: "legacy",
	},
];

afterEach(() => {
	cleanup();
	sessionStorage.clear();
});

function renderManager(
	options = OPTIONS,
	{ acceptsQuizSuggestion }: { acceptsQuizSuggestion?: boolean } = {},
) {
	const onAdd = vi.fn(() => Promise.resolve());
	const onRemove = vi.fn(() => Promise.resolve());
	render(
		<PathEnrollmentManager
			enrollments={[]}
			options={options}
			onAdd={onAdd}
			onRemove={onRemove}
			acceptsQuizSuggestion={acceptsQuizSuggestion}
		/>,
	);
	return { onAdd, onRemove };
}

function groupOf(label: string) {
	const heading = screen.getByText(label);
	const group = heading.parentElement;
	if (!group) throw new Error(`no group ${label}`);
	return within(group);
}

describe("PathEnrollmentManager and the quiz", () => {
	it("links to the quiz from the picker", async () => {
		renderManager();
		await userEvent.click(screen.getByRole("button", { name: /Add a path/ }));
		expect(
			screen.getByRole("link", { name: "Take the quiz" }).getAttribute("href"),
		).toBe(PATH_QUIZ_HREF);
	});

	it("with acceptsQuizSuggestion (the dashboard), opens with the suggested path marked and all others still listed", async () => {
		sessionStorage.setItem(QUIZ_HANDOFF_KEY, "8711");
		const { onAdd } = renderManager(OPTIONS, { acceptsQuizSuggestion: true });

		const suggested = await screen.findByText("Suggested by the quiz");
		expect(suggested).toBeTruthy();
		expect(
			groupOf("Suggested by the quiz").getByRole("button", {
				name: "Engaging Humor",
			}),
		).toBeTruthy();
		const current = groupOf("Current paths");
		expect(
			current.queryByRole("button", { name: "Engaging Humor" }),
		).toBeNull();
		expect(
			current.getByRole("button", { name: "Presentation Mastery" }),
		).toBeTruthy();
		expect(
			current.getByRole("button", { name: "Persuasive Influence" }),
		).toBeTruthy();
		expect(
			groupOf("Legacy paths").getByRole("button", {
				name: "Strategic Relationships",
			}),
		).toBeTruthy();

		// Taken once, and the quiz enrolled nobody.
		expect(sessionStorage.getItem(QUIZ_HANDOFF_KEY)).toBeNull();
		expect(onAdd).not.toHaveBeenCalled();

		// The member may override: picking another path adds that one.
		await userEvent.click(
			current.getByRole("button", { name: "Persuasive Influence" }),
		);
		expect(onAdd).toHaveBeenCalledWith("p-8707");
	});

	it("without the prop (the admin's member page), ignores the handoff", () => {
		sessionStorage.setItem(QUIZ_HANDOFF_KEY, "8711");
		renderManager();
		expect(screen.queryByText("Choose a path")).toBeNull();
		expect(sessionStorage.getItem(QUIZ_HANDOFF_KEY)).toBe("8711");
	});

	it("waits for the options before taking the handoff", () => {
		sessionStorage.setItem(QUIZ_HANDOFF_KEY, "8711");
		renderManager([], { acceptsQuizSuggestion: true });
		expect(sessionStorage.getItem(QUIZ_HANDOFF_KEY)).toBe("8711");
	});

	it("opens nothing without a handoff", () => {
		renderManager(OPTIONS, { acceptsQuizSuggestion: true });
		expect(screen.queryByText("Choose a path")).toBeNull();
	});
});

/**
 * The prop is a gate a route has to pass, and a route cannot be mounted here,
 * so the wiring is pinned in source: the member's own dashboard turns it on,
 * the admin's member page does not.
 */
describe("which surfaces accept the quiz handoff", () => {
	const src = (file: string) =>
		readFileSync(resolve(__dirname, "../../..", file), "utf8");

	it("the dashboard's picker accepts it", () => {
		const dashboard = src("src/routes/_authed/dashboard.tsx");
		const at = dashboard.indexOf("<PathEnrollmentManager");
		const end = dashboard.indexOf("/>", at);
		expect(at).toBeGreaterThan(-1);
		expect(dashboard.slice(at, end)).toMatch(
			/\bacceptsQuizSuggestion\b(?!\s*=\s*\{\s*false)/,
		);
	});

	it("the admin member page's picker does not", () => {
		const member = src("src/routes/_authed/members.$id.tsx");
		expect(member).toContain("<PathEnrollmentManager");
		expect(member).not.toMatch(/acceptsQuizSuggestion/);
	});
});

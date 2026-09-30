// @vitest-environment jsdom
/**
 * The path quiz (#935) as a visitor drives it. The route
 * (`src/routes/resources.which-path.tsx`) cannot be mounted in vitest; it
 * renders `<PathQuiz signedIn={shell} />` and nothing else of the quiz.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PATH_QUIZ,
	QUIZ_HANDOFF_HREF,
	QUIZ_HANDOFF_KEY,
} from "#/lib/path-quiz";
import { CURRENT_PATH_GUIDE } from "#/lib/pathways-catalog";
import { PathQuiz } from "./path-quiz";

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
	fetchSpy = vi.fn(() => Promise.reject(new Error("no network in the quiz")));
	vi.stubGlobal("fetch", fetchSpy);
	// jsdom does not navigate; keep a link click from logging "not implemented".
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	cleanup();
	sessionStorage.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Answer every question with the option whose label contains `pick[i]`,
 *  else the first option. */
async function answerAll(pick: Record<string, string> = {}) {
	const user = userEvent.setup();
	for (const q of PATH_QUIZ) {
		const group = screen.getByRole("group", {
			name: new RegExp(escapeRegExp(q.prompt)),
		});
		const optionId = pick[q.id] ?? q.options[0]?.id;
		const option = q.options.find((o) => o.id === optionId);
		if (!option) throw new Error(`no option ${optionId}`);
		await user.click(within(group).getByRole("radio", { name: option.label }));
	}
	return user;
}

function escapeRegExp(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("PathQuiz", () => {
	it("keeps the result back until every question is answered", async () => {
		render(<PathQuiz signedIn={false} />);
		const submit = screen.getByRole("button", { name: "See my suggestion" });
		expect(submit).toHaveProperty("disabled", true);
		await answerAll();
		expect(submit).toHaveProperty("disabled", false);
	});

	it("signed out: suggests a path with its why, focus and TI link, and the guest call to action", async () => {
		render(<PathQuiz signedIn={false} />);
		// Persuasion-leaning answers: the top result is Persuasive Influence.
		const user = await answerAll({
			"six-months": "won-round",
			skill: "pushback",
			audience: "undecided",
			excites: "win-vote",
		});
		await user.click(screen.getByRole("button", { name: "See my suggestion" }));

		const result = screen.getByRole("region", {
			name: /a path that fits|two paths that fit/i,
		});
		const card = within(result).getByRole("article", {
			name: "Persuasive Influence",
		});
		expect(card.textContent).toContain(CURRENT_PATH_GUIDE["8707"]?.focus);
		expect(card.textContent).toMatch(/You picked “.+”/);
		expect(
			within(card)
				.getByRole("link", { name: /toastmasters\.org/ })
				.getAttribute("href"),
		).toBe(CURRENT_PATH_GUIDE["8707"]?.tiUrl);
		expect(
			within(card).queryByRole("link", { name: "Use this path" }),
		).toBeNull();

		expect(
			screen.getByText("Ask the club about it at your next visit."),
		).toBeTruthy();

		// "Or browse all paths" lists all six current paths.
		const all = screen.getByRole("region", { name: "Or browse all paths" });
		expect(within(all).getAllByRole("article")).toHaveLength(6);

		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("signed in: 'Use this path' stashes only the chosen path and goes to the picker", async () => {
		render(<PathQuiz signedIn />);
		const user = await answerAll({ "six-months": "go-to-lead" });
		await user.click(screen.getByRole("button", { name: "See my suggestion" }));
		expect(
			screen.queryByText("Ask the club about it at your next visit."),
		).toBeNull();

		// Nothing has left the page, and nothing is stashed, before the click.
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(sessionStorage.getItem(QUIZ_HANDOFF_KEY)).toBeNull();

		const all = screen.getByRole("region", { name: "Or browse all paths" });
		const humor = within(all).getByRole("article", { name: "Engaging Humor" });
		const use = within(humor).getByRole("link", { name: "Use this path" });
		expect(use.getAttribute("href")).toBe(QUIZ_HANDOFF_HREF);
		await user.click(use);
		// Overriding the suggestion is as easy as taking it.
		expect(sessionStorage.getItem(QUIZ_HANDOFF_KEY)).toBe("8711");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("ignores a form submit (Enter) before every question is answered", () => {
		const { container } = render(<PathQuiz signedIn={false} />);
		const form = container.querySelector("form");
		if (!form) throw new Error("no form");
		fireEvent.submit(form);
		expect(screen.queryByRole("region", { name: /fit/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: "See my suggestion" }),
		).toBeTruthy();
	});

	it("starts again from a blank form", async () => {
		render(<PathQuiz signedIn={false} />);
		const user = await answerAll();
		await user.click(screen.getByRole("button", { name: "See my suggestion" }));
		await user.click(screen.getByRole("button", { name: "Start again" }));
		expect(
			screen.getByRole("button", { name: "See my suggestion" }),
		).toHaveProperty("disabled", true);
		expect(
			screen
				.getAllByRole("radio")
				.every((r) => !(r as HTMLInputElement).checked),
		).toBe(true);
	});
});

describe("the quiz stays off the server", () => {
	it.each([
		"src/components/pathways/path-quiz.tsx",
		"src/lib/path-quiz.ts",
	])("%s imports nothing from #/server or #/db", (file) => {
		const src = readFileSync(resolve(__dirname, "../../..", file), "utf8");
		// Any import form, `from "…"` or a bare `import "…"`.
		expect(src).not.toMatch(/["']#\/(server|db)\b/);
		expect(src).not.toMatch(/["']\.\.?\/[^"']*server/);
	});
});

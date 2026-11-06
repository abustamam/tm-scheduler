// @vitest-environment jsdom
//
// TemplateField (#1536): the menu, pills, typo help and counters. jsdom has no
// layout and no native undo stack, so backdrop alignment and undo are QA checks.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROMO_VARIABLES, type PromoValues } from "#/lib/promo-template";
import { TemplateField, UNKNOWN_CLASS } from "./template-field";
import { OPTION_ROW_HEIGHT } from "./variable-menu";

afterEach(cleanup);

const VALUES = Object.fromEntries(
	PROMO_VARIABLES.map((v) => [v.key, v.key === "theme" ? "" : `v-${v.key}`]),
) as PromoValues;

function Harness(
	props: Partial<React.ComponentProps<typeof TemplateField>> & {
		initial?: string;
		spy?: (v: string) => void;
	},
) {
	const [value, setValue] = useState(props.initial ?? "");
	return (
		<TemplateField
			id="f"
			label="Headline"
			limit={160}
			defaultValue="Default {Date}"
			values={null}
			{...props}
			value={value}
			onChange={(v) => {
				setValue(v);
				props.spy?.(v);
			}}
		/>
	);
}

function setup(props: React.ComponentProps<typeof Harness> = {}) {
	render(<Harness {...props} />);
	return {
		user: userEvent.setup(),
		ta: screen.getByLabelText("Headline") as HTMLTextAreaElement,
	};
}

const listbox = () => screen.queryByRole("listbox");

describe("opening the menu", () => {
	// protects=@ at a boundary lists every variable in 4 groups; fails_when=a variable or group is missing;
	// no_claim=popover placement.
	it("@ at the start lists every variable in its groups", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		const lb = screen.getByRole("listbox");
		expect(within(lb).getAllByRole("option")).toHaveLength(
			PROMO_VARIABLES.length,
		);
		expect(within(lb).getAllByRole("group")).toHaveLength(4);
	});

	// protects=an email's @ stays literal; fails_when=@ after a letter opens it.
	it("@ directly after a letter, digit, _ or . does not open it", async () => {
		const { user, ta } = setup();
		for (const c of ["a", "7", "_", "."]) {
			await user.clear(ta);
			await user.type(ta, `${c}@`);
			expect(listbox()).toBeNull();
		}
	});

	// protects={ opens anywhere and filters by key prefix and label word; fails_when=either path breaks;
	// no_claim=the full filter grammar (unit tests).
	it("{wo and {day find Word of the Day; a miss closes the menu", async () => {
		const { user, ta } = setup();
		await user.type(ta, "{{wo");
		expect(screen.getAllByRole("option")).toHaveLength(1);
		await user.clear(ta);
		await user.type(ta, "{{day");
		expect(
			screen.getByRole("option", { name: /Word of the Day/ }),
		).toBeTruthy();
		await user.type(ta, "zzz");
		expect(listbox()).toBeNull();
	});

	// protects=Escape closes and the same span stays closed; fails_when=typing reopens;
	// no_claim=that a new trigger later reopens (unit-tested via isSuppressed).
	it("Escape closes and typing more in the same span does not reopen", async () => {
		const { user, ta } = setup();
		await user.type(ta, "{{da");
		expect(listbox()).not.toBeNull();
		await user.keyboard("{Escape}");
		expect(listbox()).toBeNull();
		await user.keyboard("t");
		expect(listbox()).toBeNull();
	});
});

describe("picking", () => {
	// protects=ArrowDown+Enter inserts the second option at the trigger, caret after, stored key form;
	// fails_when=the trigger text stays, the caret is misplaced or the label is stored.
	it("ArrowDown then Enter replaces the trigger and filter with the pill", async () => {
		const spy = vi.fn();
		const { user, ta } = setup({ spy });
		await user.type(ta, "Hi @");
		await user.keyboard("{ArrowDown}{Enter}");
		expect(ta.value).toBe("Hi {Time}");
		expect(ta.selectionStart).toBe(ta.value.length);
		expect(listbox()).toBeNull();
	});

	// protects=Tab picks like Enter; fails_when=Tab moves focus.
	it("Tab inserts the first match", async () => {
		const { user, ta } = setup();
		await user.type(ta, "{{da");
		await user.keyboard("{Tab}");
		expect(ta.value).toBe("{Date}");
		expect(document.activeElement).toBe(ta);
	});

	// protects=ArrowUp wraps to the last option; fails_when=it stops at the top.
	it("ArrowUp from the first option wraps to the last", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		await user.keyboard("{ArrowUp}");
		const last = PROMO_VARIABLES[PROMO_VARIABLES.length - 1];
		expect(
			ta.getAttribute("aria-activedescendant")?.endsWith(`-${last.key}`),
		).toBe(true);
	});

	// protects=a mouse pick inserts and keeps focus in the textarea; fails_when=focus moves to the row.
	it("clicking an option inserts it with focus still in the textarea", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		await user.click(screen.getByRole("option", { name: /Club name/ }));
		expect(ta.value).toBe("{Club name}");
		expect(document.activeElement).toBe(ta);
	});

	// protects=Insert variable opens the same listbox, focus in the textarea, pick at the last caret;
	// fails_when=it inserts at the end or steals focus.
	it("Insert variable inserts at the last caret position", async () => {
		const { user, ta } = setup({ initial: "ab cd" });
		await user.click(ta);
		ta.setSelectionRange(2, 2);
		await user.keyboard("{ArrowRight}{ArrowLeft}");
		await user.click(screen.getByRole("button", { name: "Insert variable" }));
		expect(listbox()).not.toBeNull();
		expect(document.activeElement).toBe(ta);
		await user.click(screen.getByRole("option", { name: /^Date/ }));
		expect(ta.value).toBe("ab{Date} cd");
	});

	// protects=a never-focused field gets the variable at its end; fails_when=it is lost or put at the start.
	it("Insert variable on a never-focused field appends", async () => {
		const { user, ta } = setup({ initial: "Hello " });
		await user.click(screen.getByRole("button", { name: "Insert variable" }));
		await user.click(screen.getByRole("option", { name: /^Date/ }));
		expect(ta.value).toBe("Hello {Date}");
	});
});

describe("accessibility", () => {
	// protects=the combobox attributes exist only while open, and no explicit role;
	// fails_when=they linger when closed or the textarea gets role=combobox.
	it("sets aria-autocomplete, -controls and -activedescendant only while open", async () => {
		const { user, ta } = setup();
		const attrs = () =>
			["aria-autocomplete", "aria-controls", "aria-activedescendant"].map((a) =>
				ta.getAttribute(a),
			);
		expect(attrs()).toEqual([null, null, null]);
		await user.type(ta, "@");
		const lb = screen.getByRole("listbox");
		expect(ta.getAttribute("aria-autocomplete")).toBe("list");
		expect(ta.getAttribute("aria-controls")).toBe(lb.id);
		const active = document.getElementById(
			ta.getAttribute("aria-activedescendant") ?? "",
		);
		expect(active?.getAttribute("aria-selected")).toBe("true");
		expect(ta.hasAttribute("role")).toBe(false);
		await user.keyboard("{Escape}");
		expect(attrs()).toEqual([null, null, null]);
	});

	// protects=a polite announcement on open; fails_when=the live region stays empty.
	it("announces the count on open and the pick after", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		expect(document.querySelector("[aria-live=polite]")?.textContent).toBe(
			`${PROMO_VARIABLES.length} variables, use up and down then Enter`,
		);
		await user.keyboard("{Enter}");
		expect(document.querySelector("[aria-live=polite]")?.textContent).toBe(
			"Inserted Date",
		);
	});

	// protects=rows are 44px below md, read from the component's own constant;
	// fails_when=the height class is dropped; no_claim=real rendered height (QA pass).
	it("option rows carry the 44px class", async () => {
		const { user, ta } = setup();
		await user.type(ta, "@");
		for (const o of screen.getAllByRole("option")) {
			for (const c of OPTION_ROW_HEIGHT.split(" "))
				expect(o.classList.contains(c)).toBe(true);
		}
		expect(OPTION_ROW_HEIGHT.split(" ")[0]).toBe("h-11");
	});

	// protects=the value column: value, "not set", and nothing while unknown;
	// fails_when=an empty value shows blank or null values print "not set".
	it("shows values, 'not set', or nothing", async () => {
		const first = setup({ values: VALUES });
		await first.user.type(first.ta, "@");
		expect(screen.getByRole("option", { name: /Date/ }).textContent).toContain(
			"v-date",
		);
		expect(screen.getByRole("option", { name: /Theme/ }).textContent).toContain(
			"not set",
		);
		cleanup();
		const second = setup({ values: null });
		await second.user.type(second.ta, "@");
		expect(
			screen.getByRole("option", { name: /Date/ }).textContent,
		).not.toContain("not set");
	});
});

describe("pills and Enter", () => {
	// protects=Backspace/Delete/Arrow rules reach the DOM; fails_when=the key deletes one char.
	it("Backspace after a pill removes it whole; ArrowLeft jumps; a typo is plain text", async () => {
		const { user, ta } = setup({ initial: "x{Date}" });
		await user.click(ta);
		ta.setSelectionRange(7, 7);
		await user.keyboard("{ArrowLeft}");
		expect(ta.selectionStart).toBe(1);
		ta.setSelectionRange(7, 7);
		await user.keyboard("{Backspace}");
		expect(ta.value).toBe("x");
		cleanup();
		const typo = setup({ initial: "{Datee}" });
		typo.ta.focus();
		typo.ta.setSelectionRange(7, 7);
		await typo.user.keyboard("{Backspace}");
		expect(typo.ta.value).toBe("{Datee");
	});

	// protects=single-line fields swallow Enter, multi-line accept it; fails_when=either flips.
	it("Enter is swallowed when single-line and kept when multi-line", async () => {
		const single = setup({ multiline: false, initial: "ab" });
		await single.user.type(single.ta, "{Enter}c");
		expect(single.ta.value).toBe("abc");
		cleanup();
		const multi = setup({ initial: "ab" });
		await multi.user.type(multi.ta, "{Enter}c");
		expect(multi.ta.value).toBe("ab\nc");
	});
});

describe("counter, typos and defaults", () => {
	// protects=the counter counts the STORED length ({Word of the Day} = 14 not 17);
	// fails_when=it counts the friendly text.
	it("counts the stored form", () => {
		setup({ initial: "{Word of the Day}" });
		expect(screen.getByText("14 / 160")).toBeTruthy();
	});

	// protects=bullets count lines and the longest line; fails_when=blank lines are counted.
	it("shows bullet count and longest line", () => {
		setup({
			label: "Headline",
			limit: undefined,
			bullets: { perLine: 160, max: 8 },
			initial: "one\n\ntwelve chars",
		});
		expect(
			screen.getByText("2 of 8 bullets, longest line 12 / 160"),
		).toBeTruthy();
	});

	// protects=typo line, wavy underline and Fix; fails_when=Fix leaves the typo or the line stays;
	// no_claim=painted pixel alignment.
	it("flags {Word of Day}, paints it unknown, and Fix rewrites every occurrence", async () => {
		const { user, ta } = setup({ initial: "a {Word of Day} b {Word of Day}" });
		expect(
			screen.getByText(
				"Not a variable: {Word of Day}. Did you mean Word of the Day?",
			),
		).toBeTruthy();
		const unknown = document.querySelector(
			`[data-slot=template-field-backdrop] span`,
		);
		expect(unknown?.className).toBe(UNKNOWN_CLASS);
		await user.click(screen.getByRole("button", { name: "Fix" }));
		expect(ta.value).toBe("a {Word of the Day} b {Word of the Day}");
		expect(screen.queryByText(/Not a variable/)).toBeNull();
	});

	// protects=no-suggestion typos say "exactly as typed" with no Fix; fails_when=a Fix is offered.
	it("{foo} has no Fix", () => {
		setup({ initial: "{foo}" });
		expect(
			screen.getByText("Not a variable: {foo}. It will show exactly as typed."),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Fix" })).toBeNull();
	});

	// protects=Use default only when changed, restores without a server call;
	// fails_when=it shows on an unchanged field or does not restore.
	it("Use default appears after an edit and restores the default", async () => {
		const { user, ta } = setup({ initial: "Default {Date}" });
		expect(screen.queryByRole("button", { name: "Use default" })).toBeNull();
		await user.type(ta, "!");
		await user.click(screen.getByRole("button", { name: "Use default" }));
		expect(ta.value).toBe("Default {Date}");
		expect(screen.queryByRole("button", { name: "Use default" })).toBeNull();
	});
});

describe("paste", () => {
	// protects=a pasted stored key reads as its friendly pill immediately; fails_when=the raw key lands.
	it("converts a pasted {wordOfTheDay}", async () => {
		const { user, ta } = setup();
		await user.click(ta);
		await user.paste("{wordOfTheDay}");
		expect(ta.value).toBe("{Word of the Day}");
	});

	// protects=single-line fields flatten pasted newlines; fails_when=a newline lands.
	it("turns a newline pasted into a single-line field into a space", async () => {
		const { user, ta } = setup({ multiline: false });
		await user.click(ta);
		await user.paste("a\nb");
		expect(ta.value).toBe("a b");
	});

	// protects=a paste landing inside a pill leaves a valid pill; fails_when=the pill is split.
	it("a paste at a caret inside a pill does not split it", async () => {
		const { user, ta } = setup({ initial: "{Date}" });
		await user.click(ta);
		ta.setSelectionRange(3, 3);
		await user.paste("x");
		expect(ta.value).toMatch(/^(x\{Date\}|\{Date\}x)$/);
	});
});
